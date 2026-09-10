//! The asset plane: packages, textures, fonts, glTF.
//!
//! Loss-intolerant but restartable. A 400MB transfer must never be able to
//! delay a cue, which is why this is its own plane (ADR-001).

#![forbid(unsafe_code)]

use gx_contracts::ContentHash;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// How an asset is addressed. Both modes are retained deliberately
/// (invariant 31): the hash addresses the store, the path addresses the
/// library, so replacing a file in place keeps material bindings intact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AssetRef {
    /// Immutable identity of bytes.
    Content { hash: ContentHash },
    /// Project-relative, traversal-free. Resolved inside a configured root and
    /// re-checked after canonicalisation (invariant 42).
    Path { path: String },
}

/// Ask the engine what it already holds, so only the difference ships.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreflightRequest {
    pub hashes: Vec<ContentHash>,
}

/// The engine's answer. `missing` is what must be transferred.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResponse {
    pub missing: Vec<ContentHash>,
}

/// Transfer state for one asset. Restartable by chunk; a partial transfer
/// never becomes a cached asset (invariant 28).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum TransferState {
    /// Not started.
    Pending,
    /// Chunks arriving. Resumable from the last verified chunk.
    InProgress,
    /// Bytes hashed and matched, written to a temporary file, then renamed.
    Verified,
    /// Hash did not match what was declared. The bytes are discarded, not
    /// cached under a name claiming they were verified.
    HashMismatch,
}

/// A path this side of the boundary rejects before it reaches a filesystem.
///
/// A syntax check alone cannot see a symlink, so this is the *first* of two
/// gates, never the only one (invariant 42). The caller must still canonicalise
/// and re-check inside the configured root.
pub fn is_syntactically_safe(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.contains("..")
        && !path.contains('\0')
        // A Windows drive letter is absolute even without a leading separator.
        && !matches!(path.as_bytes().get(1), Some(b':'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traversal_and_absolute_paths_are_rejected() {
        for bad in [
            "",
            "../secrets",
            "a/../../b",
            "/etc/passwd",
            "\\\\server\\share",
            "C:\\Windows",
            "with\0null",
        ] {
            assert!(!is_syntactically_safe(bad), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn ordinary_project_paths_are_accepted() {
        for good in ["textures/logo.png", "fonts/Inter.ttf", "a/b/c.gltf"] {
            assert!(is_syntactically_safe(good), "{good:?} must be accepted");
        }
    }

    #[test]
    fn syntactic_check_is_not_the_only_gate() {
        // Documents the limit rather than pretending it does not exist: this
        // path is syntactically fine and could still be a symlink out of root.
        assert!(is_syntactically_safe("textures/maybe-a-symlink.png"));
    }
}
