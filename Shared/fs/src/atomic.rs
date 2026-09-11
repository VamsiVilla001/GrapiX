//! Atomic file replacement (build plan 2.1).
//!
//! One implementation, used by every durable write in the tree: the project
//! store, the asset store and the package writer. `fs::write` is never the
//! right call for a file that matters, and the reason is two races that both
//! produce a file whose *name* claims it is valid.
//!
//! **Race 1 — the truncation window.** `File::create` truncates the
//! destination before the first byte of the replacement is written. A crash,
//! a full disk or a killed process anywhere in that window leaves a file that
//! exists, is readable, and is empty or half-written. Closed by writing the
//! new content to a temporary file and renaming it over the destination: the
//! destination is only ever the whole old file or the whole new one.
//!
//! **Race 2 — the durability window.** A rename can reach the directory
//! before the file's data reaches the platter, so a crash immediately after
//! the rename leaves the new name pointing at an unwritten extent. Closed by
//! `sync_all` on the data *before* the rename and an fsync of the directory
//! *after* it.
//!
//! A third failure is not a race but is fatal in practice: on Windows a
//! rename onto a file that an indexer, a virus scanner or a reader holds open
//! fails outright with a sharing violation. It clears in milliseconds, so the
//! rename is retried with bounded backoff rather than surfacing as a spurious
//! save failure.
//!
//! The temporary file is created with `create_new`, so a name collision is an
//! error and never an overwrite of another writer's in-progress file.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Rename attempts before a transient failure is reported as a real one.
/// Six attempts with doubling backoff spans 63 ms, which covers a scanner
/// holding a handle without making a genuinely locked file look like a hang.
const RENAME_ATTEMPTS: u32 = 6;

/// A durable write that did not complete, named by the step that failed.
///
/// Each variant says which guarantee was lost, because the caller's response
/// differs: a failed `Sync` means the bytes may not survive a power cut, while
/// a failed `Rename` means the destination still holds the previous content.
#[derive(Debug)]
pub enum AtomicWriteError {
    /// The destination has no parent directory, so there is no same-volume
    /// rename to perform. A rename across volumes is a copy, and a copy is
    /// not atomic.
    NoParentDirectory(PathBuf),
    CreateTemporary {
        path: PathBuf,
        source: io::Error,
    },
    Write {
        path: PathBuf,
        source: io::Error,
    },
    /// The data could not be forced to disk. Reported rather than ignored:
    /// renaming unsynced data is race 2 above.
    Sync {
        path: PathBuf,
        source: io::Error,
    },
    Rename {
        from: PathBuf,
        to: PathBuf,
        attempts: u32,
        source: io::Error,
    },
    /// The directory entry could not be forced to disk. The data is durable
    /// and the rename has returned, but a crash may leave the old name.
    SyncDirectory {
        path: PathBuf,
        source: io::Error,
    },
}

impl std::fmt::Display for AtomicWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoParentDirectory(path) => {
                write!(
                    f,
                    "{} has no parent directory to write into",
                    path.display()
                )
            }
            Self::CreateTemporary { path, source } => {
                write!(
                    f,
                    "could not create temporary file {}: {source}",
                    path.display()
                )
            }
            Self::Write { path, source } => {
                write!(f, "could not write {}: {source}", path.display())
            }
            Self::Sync { path, source } => {
                write!(f, "could not flush {} to disk: {source}", path.display())
            }
            Self::Rename {
                from,
                to,
                attempts,
                source,
            } => write!(
                f,
                "could not rename {} onto {} after {attempts} attempt(s): {source}",
                from.display(),
                to.display()
            ),
            Self::SyncDirectory { path, source } => write!(
                f,
                "wrote the file but could not flush directory {}: {source}",
                path.display()
            ),
        }
    }
}

impl std::error::Error for AtomicWriteError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::NoParentDirectory(_) => None,
            Self::CreateTemporary { source, .. }
            | Self::Write { source, .. }
            | Self::Sync { source, .. }
            | Self::Rename { source, .. }
            | Self::SyncDirectory { source, .. } => Some(source),
        }
    }
}

/// Replace `path` with `bytes`, atomically and durably.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), AtomicWriteError> {
    write_atomic_with(path, |file| file.write_all(bytes))
}

/// Replace `path` with whatever `fill` writes, atomically and durably.
///
/// The closure form exists so a caller that serialises straight into the file
/// — a project store writing JSON, a package writer streaming entries — gets
/// the same guarantees without buffering the whole document twice. It is the
/// only implementation; [`write_atomic`] is a call to it.
///
/// If `fill` returns an error the destination is untouched and the temporary
/// file is removed.
pub fn write_atomic_with<F>(path: &Path, fill: F) -> Result<(), AtomicWriteError>
where
    F: FnOnce(&mut File) -> io::Result<()>,
{
    let parent = match path.parent() {
        // A bare file name has an empty parent, which is the current
        // directory — not an absent one.
        Some(parent) if parent.as_os_str().is_empty() => Path::new("."),
        Some(parent) => parent,
        None => return Err(AtomicWriteError::NoParentDirectory(path.to_path_buf())),
    };

    let temporary = temporary_path(parent, path);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|source| AtomicWriteError::CreateTemporary {
            path: temporary.clone(),
            source,
        })?;

    let written = fill(&mut file)
        .map_err(|source| AtomicWriteError::Write {
            path: temporary.clone(),
            source,
        })
        .and_then(|()| {
            file.sync_all().map_err(|source| AtomicWriteError::Sync {
                path: temporary.clone(),
                source,
            })
        });
    // Close before renaming: Windows will not rename a file this process
    // still holds open for writing.
    drop(file);

    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if let Err(error) = rename_retrying(&temporary, path, |from, to| fs::rename(from, to)) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    sync_directory(parent)
}

/// A temporary name no other writer can be using: unique by process, by
/// thread (the counter is process-global) and by time. `create_new` turns any
/// remaining collision into an error rather than a silent overwrite.
fn temporary_path(parent: &Path, target: &Path) -> PathBuf {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or(0);
    // The target's name is kept as a prefix so a leftover temporary is
    // traceable, but bounded: the whole component must stay well inside the
    // 128-character budget `gx_contracts::platform` sets for a file name.
    let stem: String = target
        .file_name()
        .map(|name| name.to_string_lossy().chars().take(40).collect())
        .unwrap_or_default();
    parent.join(format!(
        ".{stem}.{}.{sequence}.{nanos}.gxtmp",
        std::process::id()
    ))
}

/// Rename, retrying only errors that clear on their own.
///
/// The rename is injected so the retry policy is testable: holding a handle
/// open in a way that reproduces a sharing violation is not something a test
/// can do portably, and an untested retry loop is where infinite loops live.
fn rename_retrying<R>(from: &Path, to: &Path, mut rename: R) -> Result<(), AtomicWriteError>
where
    R: FnMut(&Path, &Path) -> io::Result<()>,
{
    let mut backoff = Duration::from_millis(1);
    let mut attempt = 1;
    loop {
        match rename(from, to) {
            Ok(()) => return Ok(()),
            Err(source) => {
                if attempt >= RENAME_ATTEMPTS || !is_transient(&source) {
                    return Err(AtomicWriteError::Rename {
                        from: from.to_path_buf(),
                        to: to.to_path_buf(),
                        attempts: attempt,
                        source,
                    });
                }
                std::thread::sleep(backoff);
                backoff *= 2;
                attempt += 1;
            }
        }
    }
}

/// Windows: a rename onto a file another process holds open fails with
/// `ERROR_ACCESS_DENIED` (5), `ERROR_SHARING_VIOLATION` (32) or
/// `ERROR_LOCK_VIOLATION` (33). An indexer or a scanner releases the handle
/// within milliseconds, so these are retried; anything else is real.
#[cfg(windows)]
fn is_transient(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(5 | 32 | 33)) || error.kind() == io::ErrorKind::Interrupted
}

/// POSIX: `rename(2)` does not fail because a reader has the file open, so
/// only an interrupted syscall is worth retrying. The Windows error numbers
/// are deliberately not consulted here — 5 is `EIO` and 32 is `EPIPE`, and
/// retrying either would be wrong.
#[cfg(not(windows))]
fn is_transient(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Interrupted
}

#[cfg(unix)]
fn sync_directory(directory: &Path) -> Result<(), AtomicWriteError> {
    File::open(directory)
        .and_then(|handle| handle.sync_all())
        .map_err(|source| AtomicWriteError::SyncDirectory {
            path: directory.to_path_buf(),
            source,
        })
}

/// Windows cannot open a directory through `std::fs::File`; a directory
/// handle needs `FILE_FLAG_BACKUP_SEMANTICS` through the Win32 API, which
/// means `unsafe` and this crate forbids it. NTFS journals the rename's
/// metadata, so the entry itself survives a crash — a weaker guarantee than
/// the Unix leg, stated here rather than glossed over.
#[cfg(not(unix))]
fn sync_directory(_directory: &Path) -> Result<(), AtomicWriteError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// A scratch directory under the OS temp root, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("gx-fs-{label}-{nanos}"));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn file(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        fn entries(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(&self.0)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_content_lands_and_no_temporary_survives() {
        let scratch = Scratch::new("lands");
        let target = scratch.file("project.json");
        write_atomic(&target, b"{\"v\":1}").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"{\"v\":1}");
        // A leftover temporary is a bug: the next reader would see two files
        // and the disk would fill with half-written copies.
        assert_eq!(scratch.entries(), vec!["project.json".to_string()]);
    }

    #[test]
    fn a_failed_write_leaves_the_previous_content_intact() {
        // Race 1: `File::create` would already have truncated the
        // destination by this point, and the old content would be gone.
        let scratch = Scratch::new("failed");
        let target = scratch.file("project.json");
        write_atomic(&target, b"first").unwrap();

        let result = write_atomic_with(&target, |file| {
            file.write_all(b"partial")?;
            // A named error kind, not a free string: clippy's io_other_error is
            // right that an Other-with-text hides the failure from a caller that
            // matches on the kind.
            Err(io::Error::from(io::ErrorKind::BrokenPipe))
        });

        assert!(matches!(result, Err(AtomicWriteError::Write { .. })));
        assert_eq!(fs::read(&target).unwrap(), b"first");
        assert_eq!(scratch.entries(), vec!["project.json".to_string()]);
    }

    #[test]
    fn concurrent_writers_never_interleave() {
        // Eight writers race on one path. Every reader must see one writer's
        // whole payload — never a mixture, never a short file.
        let scratch = Arc::new(Scratch::new("concurrent"));
        let target = Arc::new(scratch.file("contended.bin"));
        let payloads: Vec<Vec<u8>> = (0u8..8).map(|n| vec![n; 64 * 1024]).collect();

        std::thread::scope(|scope| {
            for payload in &payloads {
                let target = Arc::clone(&target);
                scope.spawn(move || write_atomic(&target, payload).unwrap());
            }
        });

        let final_content = fs::read(target.as_path()).unwrap();
        assert!(
            payloads.contains(&final_content),
            "the file is a mixture of writers, not one of them"
        );
        assert_eq!(scratch.entries(), vec!["contended.bin".to_string()]);
    }

    #[test]
    fn every_temporary_name_is_unique() {
        let parent = Path::new("/tmp");
        let target = Path::new("/tmp/scene.json");
        let names: std::collections::HashSet<PathBuf> =
            (0..1000).map(|_| temporary_path(parent, target)).collect();
        assert_eq!(names.len(), 1000);
    }

    #[test]
    fn a_transient_rename_failure_is_retried_until_it_clears() {
        let mut remaining_failures = 2;
        let result = rename_retrying(Path::new("from"), Path::new("to"), |_, _| {
            if remaining_failures > 0 {
                remaining_failures -= 1;
                // The sharing violation a Windows indexer produces.
                Err(io::Error::from_raw_os_error(if cfg!(windows) {
                    32
                } else {
                    4
                }))
            } else {
                Ok(())
            }
        });
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(remaining_failures, 0);
    }

    #[test]
    fn a_permanent_rename_failure_is_reported_on_the_first_attempt() {
        // Retrying a missing file forever is how a small fault becomes a hang
        // (invariant 50's lesson, one layer down).
        let mut attempts = 0;
        let result = rename_retrying(Path::new("from"), Path::new("to"), |_, _| {
            attempts += 1;
            Err(io::Error::from(io::ErrorKind::NotFound))
        });
        match result {
            Err(AtomicWriteError::Rename {
                attempts: reported, ..
            }) => assert_eq!(reported, 1),
            other => panic!("expected a rename failure, got {other:?}"),
        }
        assert_eq!(attempts, 1);
    }

    #[test]
    fn a_transient_failure_that_never_clears_stops_and_says_how_often_it_tried() {
        let mut attempts = 0;
        let result = rename_retrying(Path::new("from"), Path::new("to"), |_, _| {
            attempts += 1;
            Err(io::Error::from(io::ErrorKind::Interrupted))
        });
        match result {
            Err(AtomicWriteError::Rename {
                attempts: reported, ..
            }) => assert_eq!(reported, RENAME_ATTEMPTS),
            other => panic!("expected a rename failure, got {other:?}"),
        }
        assert_eq!(attempts, RENAME_ATTEMPTS);
    }
}
