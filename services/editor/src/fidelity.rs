//! The import fidelity gate (build plan 7.3).
//!
//! Done-when: **diff stored with the template.** The number is the deliverable,
//! not the pass/fail — "how faithful was this import?" must be answerable
//! later, by a reader who was not there, without re-running anything. A gate
//! that only returns a verdict forces every future question into a re-import,
//! and re-imports drift.
//!
//! **The seam, stated plainly.** This crate cannot render: invariant 3 forbids
//! the Editor importing renderer internals, so it cannot call the worker to
//! rasterise either the source reference or the imported scene. Frames
//! therefore arrive as *input* — the caller renders both sides and hands the
//! bytes here. That keeps the comparison in the Editor, where the record
//! belongs, without pulling the renderer in behind it.
//!
//! The comparison itself is deliberately the same arithmetic as the pixel gate
//! (4.3): differing pixel count and worst channel delta over RGBA8. A second
//! image-difference implementation would eventually disagree with the first,
//! and then two gates would report two fidelities for one import (invariant
//! 27).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::project::EditorError;

/// Two frames that could not be compared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FidelityError {
    /// Frames of different sizes are not a difference of degree. Reporting a
    /// pixel count would invent a correspondence that does not exist.
    SizeMismatch {
        reference: (u32, u32),
        imported: (u32, u32),
    },
    /// The byte count does not match the declared dimensions.
    MalformedFrame { expected: usize, actual: usize },
}

impl std::fmt::Display for FidelityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SizeMismatch {
                reference,
                imported,
            } => write!(
                f,
                "reference is {}x{} and the import is {}x{}; there is no pixel correspondence to measure",
                reference.0, reference.1, imported.0, imported.1
            ),
            Self::MalformedFrame { expected, actual } => write!(
                f,
                "frame declares {expected} RGBA8 bytes and carries {actual}"
            ),
        }
    }
}

impl std::error::Error for FidelityError {}

/// One RGBA8 frame, as the caller rendered it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame<'a> {
    pub width: u32,
    pub height: u32,
    pub pixels: &'a [u8],
}

impl Frame<'_> {
    fn check(&self) -> Result<(), FidelityError> {
        let expected = self.width as usize * self.height as usize * 4;
        if self.pixels.len() == expected {
            Ok(())
        } else {
            Err(FidelityError::MalformedFrame {
                expected,
                actual: self.pixels.len(),
            })
        }
    }
}

/// What the comparison found. Persisted beside the template.
///
/// `differing_pixels` and `worst_channel_delta` rather than a single score: a
/// thousand pixels off by one and one pixel off by two hundred are different
/// import failures, and a score that averaged them would hide both.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FidelityRecord {
    pub source_name: String,
    pub width: u32,
    pub height: u32,
    pub total_pixels: u64,
    pub differing_pixels: u64,
    pub worst_channel_delta: u8,
}

impl FidelityRecord {
    /// Whether this import reproduced its source exactly.
    pub fn verdict(&self) -> FidelityVerdict {
        if self.differing_pixels == 0 {
            FidelityVerdict::Identical
        } else {
            FidelityVerdict::Differs
        }
    }
}

/// The gate's answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FidelityVerdict {
    Identical,
    Differs,
}

/// Compare a source reference render against the imported render.
pub fn compare(
    source_name: &str,
    reference: Frame<'_>,
    imported: Frame<'_>,
) -> Result<FidelityRecord, FidelityError> {
    reference.check()?;
    imported.check()?;
    if (reference.width, reference.height) != (imported.width, imported.height) {
        return Err(FidelityError::SizeMismatch {
            reference: (reference.width, reference.height),
            imported: (imported.width, imported.height),
        });
    }

    let mut differing_pixels = 0_u64;
    let mut worst_channel_delta = 0_u8;
    for (a, b) in reference
        .pixels
        .chunks_exact(4)
        .zip(imported.pixels.chunks_exact(4))
    {
        let mut differs = false;
        for channel in 0..4 {
            let delta = a[channel].abs_diff(b[channel]);
            if delta > 0 {
                differs = true;
                worst_channel_delta = worst_channel_delta.max(delta);
            }
        }
        if differs {
            differing_pixels += 1;
        }
    }

    Ok(FidelityRecord {
        source_name: source_name.to_owned(),
        width: reference.width,
        height: reference.height,
        total_pixels: u64::from(reference.width) * u64::from(reference.height),
        differing_pixels,
        worst_channel_delta,
    })
}

/// Where the record lives relative to the template it describes.
pub fn record_path(template: &Path) -> PathBuf {
    let mut name = template
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "template".to_owned());
    name.push_str(".fidelity.json");
    template.with_file_name(name)
}

/// Store the record beside its template.
///
/// Through `write_atomic` like every other durable write: a half-written
/// fidelity record is a file that claims a number nobody measured.
pub fn store(template: &Path, record: &FidelityRecord) -> Result<PathBuf, EditorError> {
    let path = record_path(template);
    let bytes = serde_json::to_vec_pretty(record).map_err(EditorError::Serialize)?;
    gx_fs::write_atomic(&path, &bytes).map_err(EditorError::Write)?;
    Ok(path)
}

/// Read back a stored record.
pub fn load(template: &Path) -> Result<FidelityRecord, EditorError> {
    let path = record_path(template);
    let bytes = std::fs::read(&path).map_err(|source| EditorError::Io {
        path: path.clone(),
        source,
    })?;
    serde_json::from_slice(&bytes).map_err(EditorError::Serialize)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("gx-editor-fidelity-{label}-{nanos}"));
        std::fs::create_dir_all(&path).expect("scratch directory");
        path
    }

    #[test]
    fn an_exact_import_measures_zero() {
        let pixels = [1_u8, 2, 3, 255, 4, 5, 6, 255];
        let record = compare(
            "brand.svg",
            Frame {
                width: 2,
                height: 1,
                pixels: &pixels,
            },
            Frame {
                width: 2,
                height: 1,
                pixels: &pixels,
            },
        )
        .expect("same size compares");

        assert_eq!(record.differing_pixels, 0);
        assert_eq!(record.worst_channel_delta, 0);
        assert_eq!(record.verdict(), FidelityVerdict::Identical);
    }

    #[test]
    fn the_record_separates_how_many_from_how_badly() {
        // A thousand pixels off by one and one pixel off by two hundred are
        // different failures; a single score would hide both.
        let reference = [0_u8, 0, 0, 255, 0, 0, 0, 255];
        let imported = [0_u8, 0, 0, 255, 200, 0, 0, 255];
        let record = compare(
            "brand.svg",
            Frame {
                width: 2,
                height: 1,
                pixels: &reference,
            },
            Frame {
                width: 2,
                height: 1,
                pixels: &imported,
            },
        )
        .unwrap();

        assert_eq!(record.differing_pixels, 1);
        assert_eq!(record.worst_channel_delta, 200);
        assert_eq!(record.total_pixels, 2);
        assert_eq!(record.verdict(), FidelityVerdict::Differs);
    }

    #[test]
    fn frames_of_different_sizes_refuse_rather_than_inventing_a_correspondence() {
        let a = [0_u8; 8];
        let b = [0_u8; 4];
        assert_eq!(
            compare(
                "x",
                Frame {
                    width: 2,
                    height: 1,
                    pixels: &a
                },
                Frame {
                    width: 1,
                    height: 1,
                    pixels: &b
                },
            ),
            Err(FidelityError::SizeMismatch {
                reference: (2, 1),
                imported: (1, 1)
            })
        );
    }

    #[test]
    fn a_frame_whose_bytes_contradict_its_dimensions_refuses() {
        let short = [0_u8; 3];
        assert_eq!(
            compare(
                "x",
                Frame {
                    width: 2,
                    height: 1,
                    pixels: &short
                },
                Frame {
                    width: 2,
                    height: 1,
                    pixels: &short
                },
            ),
            Err(FidelityError::MalformedFrame {
                expected: 8,
                actual: 3
            })
        );
    }

    #[test]
    fn the_diff_is_stored_beside_the_template_and_reads_back() {
        // 7.3's done-when. The number must outlive the run that produced it,
        // so a later reader can ask how faithful the import was without
        // re-importing.
        let root = scratch("stored");
        let template = root.join("lower-third.gpxpkg");
        std::fs::write(&template, b"template").unwrap();

        let reference = [0_u8, 0, 0, 255];
        let imported = [3_u8, 0, 0, 255];
        let record = compare(
            "brand.svg",
            Frame {
                width: 1,
                height: 1,
                pixels: &reference,
            },
            Frame {
                width: 1,
                height: 1,
                pixels: &imported,
            },
        )
        .unwrap();

        let written = store(&template, &record).expect("the record stores");
        assert_eq!(written, root.join("lower-third.fidelity.json"));
        assert!(
            written.exists(),
            "the record must sit beside the template it describes"
        );
        assert_eq!(load(&template).expect("and reads back"), record);

        std::fs::remove_dir_all(root).expect("clean up");
    }
}
