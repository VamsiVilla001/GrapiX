//! Reading a CSV file as a data source (Panchayati task 121 slice 2, plan row 11.153).
//!
//! The rules of reading are `gx_contracts::csv_table` (one reader, strict, named faults with their lines). This is the part that touches a
//! file: it checks what the path is, checks the size from the file's metadata **before reading a byte** (a 4 GB file is refused, not read),
//! reads at most the limit plus one byte, and fingerprints the very bytes it parsed (SHA-256, the same content address assets use), so the
//! hash is of what was read and never of a second read of a file that may have changed in between.
//!
//! The project importer stores the same bytes that passed the bounded reader.

use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};

use gx_contracts::csv_table::{parse_csv, CsvFault, CsvLimits, Delimiter, Limit, TextTable};
use gx_contracts::ContentHash;
use sha2::{Digest, Sha256};

/// A CSV file read in full: its table and what identifies the bytes it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CsvRead {
    /// The file's own name (no directory), as a label.
    pub file_name: String,
    /// The size of the file in bytes, a byte order mark included.
    pub bytes: u64,
    /// SHA-256 of the file's bytes, lowercase hex.
    pub content_hash: ContentHash,
    /// The delimiter the caller stated; it is not detected and not stored by the reader.
    pub delimiter: Delimiter,
    pub table: TextTable,
}

/// Why a file was not read as a source. Each says which file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CsvSourceError {
    /// There is no file at the path.
    Missing { path: PathBuf },
    /// The path is not a regular file (a folder or a device).
    NotAFile { path: PathBuf },
    /// The file exists and could not be opened or read. `reason` is the operating system's.
    Unreadable { path: PathBuf, reason: String },
    /// The file was read and is not a CSV the reader accepts (or is over a limit): the reader's own named fault.
    Csv { path: PathBuf, fault: CsvFault },
}

impl fmt::Display for CsvSourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing { path } => write!(f, "there is no file at {}", path.display()),
            Self::NotAFile { path } => write!(
                f,
                "{} is not a file (a folder or a device cannot be a CSV source)",
                path.display()
            ),
            Self::Unreadable { path, reason } => {
                write!(f, "{} cannot be read: {reason}", path.display())
            }
            Self::Csv { path, fault } => {
                write!(f, "{} is not read as a CSV: {fault}", path.display())
            }
        }
    }
}

impl std::error::Error for CsvSourceError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Csv { fault, .. } => Some(fault),
            _ => None,
        }
    }
}

/// Read the CSV file at `path` with the stated `delimiter` and `limits`.
///
/// The size is taken from the file's metadata and a file over `limits.max_bytes` is refused before any of it is read. The read itself is
/// capped at one byte over the limit, so a file that grows after the check is still refused, never read without bound.
pub fn read_csv_file(
    path: &Path,
    delimiter: Delimiter,
    limits: &CsvLimits,
) -> Result<CsvRead, CsvSourceError> {
    read_csv_snapshot(path, delimiter, limits).map(|(read, _)| read)
}

pub(crate) fn read_csv_snapshot(
    path: &Path,
    delimiter: Delimiter,
    limits: &CsvLimits,
) -> Result<(CsvRead, Vec<u8>), CsvSourceError> {
    let unreadable = |error: std::io::Error| CsvSourceError::Unreadable {
        path: path.to_path_buf(),
        reason: error.to_string(),
    };
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(CsvSourceError::Missing {
                path: path.to_path_buf(),
            })
        }
        Err(error) => return Err(unreadable(error)),
    };
    let Some(file_name) = path.file_name().filter(|_| meta.is_file()) else {
        return Err(CsvSourceError::NotAFile {
            path: path.to_path_buf(),
        });
    };
    if meta.len() > u64::from(limits.max_bytes) {
        return Err(CsvSourceError::Csv {
            path: path.to_path_buf(),
            fault: CsvFault::TooLarge {
                limit: Limit::FileBytes,
                allowed: limits.max_bytes,
                found: u32::try_from(meta.len()).unwrap_or(u32::MAX),
            },
        });
    }
    let file = std::fs::File::open(path).map_err(unreadable)?;
    let bytes = read_at_most(file, limits.max_bytes, meta.len()).map_err(unreadable)?;
    let table = parse_csv(&bytes, delimiter, limits).map_err(|fault| CsvSourceError::Csv {
        path: path.to_path_buf(),
        fault,
    })?;
    Ok((CsvRead {
        file_name: file_name.to_string_lossy().into_owned(),
        bytes: bytes.len() as u64,
        content_hash: ContentHash(format!("{:x}", Sha256::digest(&bytes))),
        delimiter,
        table,
    }, bytes))
}

/// The bytes of `source`, but never more than `max_bytes` plus one: the one over is enough for the reader to refuse a file that grew past its
/// limit after the size was checked, and nothing past it is read. `expected` is only how much room to make.
fn read_at_most(source: impl Read, max_bytes: u32, expected: u64) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(usize::try_from(expected).unwrap_or(0));
    source
        .take(u64::from(max_bytes) + 1)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder under the system temp directory, removed when dropped.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let suffix = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "gx-csv-source-{label}-{}-{suffix}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("scratch folder");
            Self(path)
        }

        fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, bytes).expect("write test file");
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn comma() -> Delimiter {
        Delimiter::Comma
    }

    #[test]
    fn a_file_is_read_with_its_name_size_and_the_hash_of_its_bytes() {
        let scratch = Scratch::new("read");
        let path = scratch.file("Players.csv", b"a,b\n1,2\n");
        let read = read_csv_file(&path, comma(), &CsvLimits::default()).unwrap();
        assert_eq!(read.file_name, "Players.csv");
        assert_eq!(read.bytes, 8);
        assert_eq!(
            read.content_hash,
            ContentHash(
                "492d5ea496056f1a6a6592241032fab764c321596317930b4fa0e1e8bc3b7470".to_owned()
            ),
            "the SHA-256 of the file's bytes (checked against an independent implementation)"
        );
        assert_eq!(read.delimiter, comma());
        assert_eq!(read.table.columns, ["a", "b"]);
        assert_eq!(read.table.rows, [["1", "2"]]);
    }

    #[test]
    fn the_hash_is_of_the_files_bytes_so_a_byte_order_mark_changes_it_and_the_size_counts_it() {
        let scratch = Scratch::new("bom");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"a,b\n1,2\n");
        let read = read_csv_file(
            &scratch.file("x.csv", &bytes),
            comma(),
            &CsvLimits::default(),
        )
        .unwrap();
        assert_eq!(read.bytes, 11);
        assert_eq!(
            read.content_hash.0,
            "4baf8d035fbc583379d998ac9ed3d18276d308ee43cf945ee88d0c54cca33992"
        );
        assert_eq!(
            read.table.columns,
            ["a", "b"],
            "the table has no mark in it"
        );
    }

    #[test]
    fn text_in_another_script_comes_back_exactly_and_the_stated_delimiter_is_used() {
        let scratch = Scratch::new("hindi");
        let path = scratch.file("खिलाड़ी.csv", "नाम;भूमिका\nअर्जुन;कमेंटेटर\n".as_bytes());
        let read = read_csv_file(&path, Delimiter::Semicolon, &CsvLimits::default()).unwrap();
        assert_eq!(read.file_name, "खिलाड़ी.csv");
        assert_eq!(read.delimiter, Delimiter::Semicolon);
        assert_eq!(read.table.columns, ["नाम", "भूमिका"]);
        assert_eq!(read.table.rows, [["अर्जुन", "कमेंटेटर"]]);
    }

    #[test]
    fn a_missing_path_a_folder_and_a_name_with_no_file_are_refused_by_name() {
        let scratch = Scratch::new("paths");
        let missing = scratch.0.join("nope.csv");
        assert_eq!(
            read_csv_file(&missing, comma(), &CsvLimits::default()),
            Err(CsvSourceError::Missing {
                path: missing.clone()
            })
        );
        assert_eq!(
            read_csv_file(&scratch.0, comma(), &CsvLimits::default()),
            Err(CsvSourceError::NotAFile {
                path: scratch.0.clone()
            }),
            "a folder cannot be a source"
        );
        let said = read_csv_file(&missing, comma(), &CsvLimits::default())
            .unwrap_err()
            .to_string();
        assert!(
            said.contains("there is no file at") && said.contains("nope.csv"),
            "{said}"
        );
    }

    #[test]
    fn a_fault_of_the_reader_reaches_the_caller_named_with_its_line_and_the_file() {
        let scratch = Scratch::new("fault");
        let path = scratch.file("ragged.csv", b"a,b\n1,2\n3\n");
        let error = read_csv_file(&path, comma(), &CsvLimits::default()).unwrap_err();
        assert_eq!(
            error,
            CsvSourceError::Csv {
                path: path.clone(),
                fault: CsvFault::RaggedRow {
                    line: 3,
                    expected: 2,
                    found: 1
                }
            }
        );
        let said = error.to_string();
        assert!(
            said.contains("ragged.csv") && said.contains("line 3 has 1 cells and the header has 2"),
            "{said}"
        );
        assert!(std::error::Error::source(&error).is_some());
    }

    #[test]
    fn the_size_is_judged_from_the_metadata_before_any_byte_is_decoded() {
        let scratch = Scratch::new("big");
        // Not UTF-8 at all, and over the limit: the answer is the size, because nothing was read to find out it is not text.
        let path = scratch.file("big.csv", &[0xFF; 40]);
        let limits = CsvLimits {
            max_bytes: 10,
            ..CsvLimits::default()
        };
        assert_eq!(
            read_csv_file(&path, comma(), &limits),
            Err(CsvSourceError::Csv {
                path: path.clone(),
                fault: CsvFault::TooLarge {
                    limit: Limit::FileBytes,
                    allowed: 10,
                    found: 40
                }
            })
        );
    }

    #[test]
    fn a_file_exactly_at_the_limit_is_read_and_one_byte_over_is_refused() {
        let scratch = Scratch::new("edge");
        let at = scratch.file("at.csv", b"a,b\n1,2\n");
        let over = scratch.file("over.csv", b"a,b\n1,2\n\n");
        let limits = CsvLimits {
            max_bytes: 8,
            ..CsvLimits::default()
        };
        assert!(read_csv_file(&at, comma(), &limits).is_ok());
        assert!(matches!(
            read_csv_file(&over, comma(), &limits),
            Err(CsvSourceError::Csv {
                fault: CsvFault::TooLarge {
                    limit: Limit::FileBytes,
                    allowed: 8,
                    found: 9
                },
                ..
            })
        ));
    }

    #[test]
    fn a_file_that_is_not_text_is_refused_by_what_it_looks_like() {
        let scratch = Scratch::new("latin");
        let path = scratch.file("latin.csv", b"name,city\nJos\xE9,Z\xFCrich\n");
        assert!(matches!(
            read_csv_file(&path, comma(), &CsvLimits::default()),
            Err(CsvSourceError::Csv {
                fault: CsvFault::NotUtf8 { .. },
                ..
            })
        ));
    }

    #[test]
    fn a_source_that_never_ends_is_read_to_one_byte_over_the_limit_and_no_further() {
        // A file that grows after its size was checked: the reader gets one byte over, which is how it knows to refuse.
        let endless = read_at_most(std::io::repeat(b'x'), 5, 0).unwrap();
        assert_eq!(endless.len(), 6);
        assert_eq!(read_at_most(&b"abc"[..], 5, 3).unwrap(), b"abc");
        assert_eq!(read_at_most(&b"abcde"[..], 5, 5).unwrap(), b"abcde");
        let over = parse_csv(
            &endless,
            comma(),
            &CsvLimits {
                max_bytes: 5,
                ..CsvLimits::default()
            },
        );
        assert!(matches!(
            over,
            Err(CsvFault::TooLarge {
                limit: Limit::FileBytes,
                allowed: 5,
                found: 6
            })
        ));
    }

    /// Windows: a file another program holds open exclusively can be seen but not read.
    #[cfg(windows)]
    #[test]
    fn a_file_that_is_held_open_by_another_program_is_unreadable_and_says_why() {
        use std::os::windows::fs::OpenOptionsExt;
        let scratch = Scratch::new("locked");
        let path = scratch.file("held.csv", b"a,b\n1,2\n");
        let _holder = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .expect("hold the file exclusively");
        let error = read_csv_file(&path, comma(), &CsvLimits::default()).unwrap_err();
        let CsvSourceError::Unreadable {
            path: named,
            reason,
        } = &error
        else {
            panic!("expected Unreadable, got {error:?}");
        };
        assert_eq!(named, &path);
        assert!(!reason.is_empty());
        let said = error.to_string();
        assert!(
            said.contains("held.csv") && said.contains("cannot be read"),
            "{said}"
        );
    }

    /// Windows: a name the system rejects outright is not "no such file": it is a path that cannot be read, with the system's reason.
    #[cfg(windows)]
    #[test]
    fn a_path_the_system_rejects_is_unreadable_and_not_missing() {
        let scratch = Scratch::new("badname");
        let path = scratch.0.join("what?.csv");
        let error = read_csv_file(&path, comma(), &CsvLimits::default()).unwrap_err();
        assert!(
            matches!(&error, CsvSourceError::Unreadable { reason, .. } if !reason.is_empty()),
            "{error:?}"
        );
    }

    #[test]
    fn reading_leaves_the_file_as_it_was() {
        let scratch = Scratch::new("readonly");
        let path = scratch.file("keep.csv", b"a,b\n1,2\n");
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        read_csv_file(&path, comma(), &CsvLimits::default()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"a,b\n1,2\n");
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            before
        );
    }

    /// A file of a hundred thousand rows, as a feed export may be: read in full and counted.
    #[test]
    fn a_large_file_is_read_in_full() {
        let scratch = Scratch::new("large");
        let mut text = String::from("id,name\n");
        for n in 0..100_000 {
            text.push_str(&format!("{n},Player {n}\n"));
        }
        let path = scratch.file("large.csv", text.as_bytes());
        let read = read_csv_file(&path, comma(), &CsvLimits::default()).unwrap();
        assert_eq!(read.table.rows.len(), 100_000);
        assert_eq!(read.bytes, text.len() as u64);
    }
}
