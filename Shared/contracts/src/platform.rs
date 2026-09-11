//! Platform primitives that are pure policy: filename sanitisation and OS
//! directory conventions (ADR-0002 B.3, build plan 2.2 and 2.4).
//!
//! These live in contracts rather than a service crate because every plane
//! applies them identically: the asset plane sanitises on import, the project
//! store writes under the OS data root, and a second implementation anywhere
//! else would drift (invariant 27).
//!
//! 2.2's done-when is a hostile-name corpus; the test module at the bottom
//! is that corpus.

use std::path::{Path, PathBuf};

use unicode_normalization::UnicodeNormalization;

use crate::Refusal;

/// Windows reserved device names (base name, case-insensitive). A layer
/// named "AUX" becoming an unwriteable file is the recorded 1.x failure
/// (ADR-0002 B.3).
const WINDOWS_RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Characters Windows forbids in a filename. macOS forbids `:` and `/`,
/// both covered here; we apply the stricter set on every platform so a name
/// legalised on macOS is still legal when a project moves to Windows.
const ILLEGAL_CHARS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// Windows' classic MAX_PATH. Long-path opt-in exists but nothing in a
/// facility enables it reliably, so names are kept well under it and the
/// total path budget is the caller's problem, named here so it is one
/// constant rather than folklore.
pub const MAX_COMPONENT_LEN: usize = 128;

/// Sanitise a single path component (a file or directory name, never a
/// path). The one place user text becomes a filename: display name and
/// on-disk name are separate fields, and this function produces the latter
/// (ADR-0002 B.3 "sanitise on import, once").
///
/// The transformation is total: every input yields a name that is legal on
/// both platforms, NFC-normalised, never reserved, never empty.
pub fn sanitize_filename(name: &str) -> String {
    // NFC first, so the character set a name is judged against is the one it
    // is stored with.
    let nfc: String = name.nfc().collect();
    let mut out = String::with_capacity(nfc.len());
    for ch in nfc.chars() {
        if ILLEGAL_CHARS.contains(&ch) || ch.is_control() {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    // Trailing dots and spaces are unwriteable on Windows.
    let trimmed = out.trim_end_matches(['.', ' ']).to_string();
    let mut trimmed = trimmed;
    // Bound the length on characters, not bytes, and stay well under 260.
    if trimmed.chars().count() > MAX_COMPONENT_LEN {
        trimmed = trimmed.chars().take(MAX_COMPONENT_LEN).collect();
    }
    if trimmed.is_empty() {
        trimmed = "unnamed".to_string();
    }
    if WINDOWS_RESERVED
        .iter()
        .any(|r| trimmed.eq_ignore_ascii_case(r))
    {
        trimmed = format!("_{trimmed}");
    }
    trimmed
}

/// Whether a name is already in canonical form — used by validators that
/// must refuse rather than rewrite.
pub fn is_canonical_filename(name: &str) -> bool {
    sanitize_filename(name) == name
}

/// The platform policy for the service data root (ADR-0002 B.3, 2.4). The
/// returned path uses OS conventions; the in-repo default of 1.x is gone.
///
/// Returns a refusal rather than a guess when the OS cannot name a config
/// directory: a service that cannot find its data root must say so, not
/// write into whatever directory it was launched from.
pub fn service_data_root() -> Result<PathBuf, Refusal> {
    directories::ProjectDirs::from("com", "GrapiX", "GrapiX")
        .map(|dirs| dirs.data_dir().to_path_buf())
        .ok_or_else(|| Refusal::PlatformDirectoryUnavailable {
            detail: "the OS could not name a per-user data directory".into(),
        })
}

/// The cache/asset-store root (separate from data: caches are expendable).
pub fn cache_root() -> Result<PathBuf, Refusal> {
    directories::ProjectDirs::from("com", "GrapiX", "GrapiX")
        .map(|dirs| dirs.cache_dir().to_path_buf())
        .ok_or_else(|| Refusal::PlatformDirectoryUnavailable {
            detail: "the OS could not name a per-user cache directory".into(),
        })
}

/// The log root.
pub fn log_root() -> Result<PathBuf, Refusal> {
    directories::ProjectDirs::from("com", "GrapiX", "GrapiX")
        .map(|dirs| {
            // macOS has a dedicated Logs convention; the `directories` crate
            // does not expose it, so apply it directly.
            #[cfg(target_os = "macos")]
            {
                let _ = &dirs;
                dirs.config_dir()
                    .parent()
                    .map(|p| p.join("Logs").join("GrapiX"))
                    .unwrap_or_else(|| dirs.data_dir().join("logs"))
            }
            #[cfg(not(target_os = "macos"))]
            {
                dirs.data_dir().join("logs")
            }
        })
        .ok_or_else(|| Refusal::PlatformDirectoryUnavailable {
            detail: "the OS could not name a log directory".into(),
        })
}

/// Whether `path` is under `root` after canonicalisation — the second gate
/// of invariant 42. `is_syntactically_safe` (asset plane) is the first; a
/// syntax check cannot see a symlink, so the canonical re-check exists.
/// Both paths must exist for canonicalisation; callers creating files check
/// the parent instead.
pub fn is_inside_root(path: &Path, root: &Path) -> bool {
    match (path.canonicalize(), root.canonicalize()) {
        (Ok(p), Ok(r)) => p.starts_with(r),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Case canonicalisation (2.3).
//
// The fault: NTFS and the default APFS volume are case-insensitive, ext4 and
// a case-sensitive APFS volume are not. A project where one layer references
// `Logo.png` and another `logo.png` is one asset on the laptop it was
// authored on and two on the build machine — or the reverse: an import that
// silently overwrote a file on one volume creates a second file on the other,
// and the scene now resolves to bytes nobody chose.
//
// The policy is therefore *ours*, not the filesystem's: names compare
// case-insensitively everywhere, which is the stricter of the two behaviours,
// and the author's own casing is preserved for display. Applying the strict
// rule on every volume is what makes a case-sensitive volume behave
// identically to an insensitive one — 2.3's done-when.
// ---------------------------------------------------------------------------

/// A file or directory name that compares by case-folded form and displays
/// as the author typed it.
///
/// This is a type rather than a pair of helper functions because the rule is
/// only unbreakable if the wrong comparison is unavailable: `PartialEq`,
/// `Ord` and `Hash` all use the folded form, so a `HashMap<FileName, _>` or a
/// `==` written without thinking still obeys the policy, while `Display` and
/// [`FileName::display`] still show `Logo.png`.
#[derive(Debug, Clone)]
pub struct FileName {
    display: String,
    folded: String,
}

impl FileName {
    /// Take a name as the author wrote it. The name is *not* sanitised here:
    /// [`sanitize_filename`] is a separate decision made once at import, and
    /// silently rewriting a name during a comparison would hide the very
    /// collision this type exists to surface.
    pub fn new(name: impl Into<String>) -> Self {
        let display = name.into();
        let folded = fold_case(&display);
        Self { display, folded }
    }

    /// The name as the author wrote it.
    pub fn display(&self) -> &str {
        &self.display
    }

    /// The comparison form. Exposed for callers that must persist a key.
    pub fn folded(&self) -> &str {
        &self.folded
    }

    /// Whether these are the same name spelled differently — equal under the
    /// policy, distinguishable on screen. An importer reports this rather
    /// than picking a winner.
    pub fn is_case_variant_of(&self, other: &Self) -> bool {
        self.folded == other.folded && self.display != other.display
    }
}

impl PartialEq for FileName {
    fn eq(&self, other: &Self) -> bool {
        self.folded == other.folded
    }
}

impl Eq for FileName {}

impl std::hash::Hash for FileName {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.folded.hash(state);
    }
}

impl PartialOrd for FileName {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for FileName {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.folded.cmp(&other.folded)
    }
}

impl std::fmt::Display for FileName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.display)
    }
}

/// The comparison form of a name: NFC, then Unicode lowercase.
///
/// NFC first, because `é` composed and `é` decomposed are the same name to a
/// user and to macOS, and lowercasing does not unify them. Rust's
/// `to_lowercase` is locale-independent, which is deliberate: a Turkish
/// locale mapping `I` to `ı` would make a project's names depend on the
/// operator's regional settings.
pub fn fold_case(name: &str) -> String {
    name.nfc().collect::<String>().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The hostile-name corpus of 2.2: every row names a recorded failure
    /// mode from ADR-0002 B.3. Each must come out legal on both platforms,
    /// non-empty, unreserved, and within the length bound.
    #[test]
    fn hostile_names_come_out_legal() {
        let cases: &[(&str, &str)] = &[
            // Illegal characters (Figma/PSD exports carry these constantly).
            ("Lower Third: v2 <final>", "Lower Third_ v2 _final_"),
            ("a/b\\c|d?e*f\"g", "a_b_c_d_e_f_g"),
            // Trailing dots and spaces — unwriteable on Windows.
            ("lowerthird.", "lowerthird"),
            ("lowerthird   ", "lowerthird"),
            ("...", "unnamed"),
            // Reserved device names, case-insensitive.
            ("AUX", "_AUX"),
            ("aux", "_aux"),
            ("com1", "_com1"),
            ("LPT9", "_LPT9"),
            ("nul", "_nul"),
            // Control characters.
            ("a\u{0007}b", "a_b"),
            ("tab\there", "tab_here"), // \t is a control char, replaced
            // Empty and whitespace.
            ("", "unnamed"),
            ("   ", "unnamed"),
            // Unicode: NFC normalisation (é as e+combining accent composes).
            ("cafe\u{0301}", "café"),
        ];
        for (input, expected) in cases {
            let got = sanitize_filename(input);
            assert_eq!(&got, expected, "input {input:?}");
            // And every output is idempotent — sanitising twice changes nothing.
            assert_eq!(got, sanitize_filename(&got), "not idempotent: {got:?}");
        }
    }

    #[test]
    fn long_names_are_bounded_in_characters() {
        let long = "x".repeat(500);
        let got = sanitize_filename(&long);
        assert_eq!(got.chars().count(), MAX_COMPONENT_LEN);
        // A multi-byte name is bounded in chars, so it can only shrink in bytes.
        let wide = "日本語".repeat(100);
        let got = sanitize_filename(&wide);
        assert!(got.chars().count() <= MAX_COMPONENT_LEN);
    }

    #[test]
    fn reserved_detection_is_case_insensitive_but_near_misses_pass() {
        assert!(!is_canonical_filename("CON"));
        assert!(!is_canonical_filename("con"));
        assert!(is_canonical_filename("console")); // not reserved
        assert!(is_canonical_filename("aux.json")); // extension distinguishes it
    }

    #[test]
    fn the_service_roots_exist_on_this_platform() {
        // 2.4's done-when on the platform that runs the gate. The roots must
        // be absolute and must not point inside the repository (the 1.x bug
        // this step exists to fix).
        for root in [service_data_root(), cache_root(), log_root()] {
            let root = root.expect("OS must name the directory");
            assert!(root.is_absolute(), "{root:?} is not absolute");
            let cwd = std::env::current_dir().unwrap();
            assert!(
                !root.starts_with(&cwd),
                "{root:?} points inside the working directory — the in-repo default is back"
            );
        }
    }

    #[test]
    fn canonicalisation_gate_sees_through_dotdot() {
        let root = std::env::temp_dir();
        let outside = root.join("..").canonicalize().unwrap();
        assert!(!is_inside_root(&outside, &root));
        assert!(is_inside_root(&root, &root));
    }

    #[test]
    fn a_name_compares_folded_and_displays_as_authored() {
        let authored = FileName::new("Logo.PNG");
        let referenced = FileName::new("logo.png");
        assert_eq!(authored, referenced, "case must not distinguish two names");
        assert_eq!(authored.display(), "Logo.PNG", "display is verbatim");
        assert!(authored.is_case_variant_of(&referenced));
        assert!(!authored.is_case_variant_of(&FileName::new("Logo.PNG")));
        // The wrong comparison must be unavailable, not merely discouraged:
        // a map keyed by the type obeys the policy without the caller
        // remembering to fold.
        let mut library = std::collections::HashMap::new();
        library.insert(FileName::new("Logo.PNG"), "first import");
        assert_eq!(
            library.insert(FileName::new("logo.png"), "second import"),
            Some("first import"),
            "a second spelling must collide, not create a second entry"
        );
        assert_eq!(library.len(), 1);
    }

    #[test]
    fn folding_is_normalisation_aware_and_locale_independent() {
        // Composed and decomposed forms are one name to a user and to macOS.
        let composed = FileName::new("Café.png");
        let decomposed = FileName::new("Cafe\u{0301}.png");
        assert_eq!(composed, decomposed);
        assert_ne!(
            composed.display(),
            decomposed.display(),
            "the two spellings are still distinguishable on screen"
        );
        // A Turkish locale would fold `I` to `ı` and split these; Rust's
        // mapping is locale-independent, so a project's names cannot depend
        // on the operator's regional settings.
        assert_eq!(FileName::new("FILE"), FileName::new("file"));
        assert_eq!(fold_case("FILE"), "file");
    }

    #[test]
    fn a_case_sensitive_volume_resolves_the_same_names_as_an_insensitive_one() {
        // 2.3's done-when. The lookup a project store performs — match a
        // referenced name against what the directory actually holds — is
        // decided by this policy and not by the volume, so it gives the same
        // answer on NTFS, on APFS and on ext4.
        let scratch = std::env::temp_dir().join(format!(
            "gx-case-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&scratch).unwrap();
        std::fs::write(scratch.join("Logo.png"), b"bytes").unwrap();

        let on_disk: Vec<FileName> = std::fs::read_dir(&scratch)
            .unwrap()
            .map(|entry| FileName::new(entry.unwrap().file_name().to_string_lossy().into_owned()))
            .collect();
        let referenced = FileName::new("logo.png");
        let found = on_disk.iter().find(|name| **name == referenced);

        assert!(
            found.is_some(),
            "the reference must resolve whatever the volume does"
        );
        assert_eq!(
            found.unwrap().display(),
            "Logo.png",
            "and it resolves to the file as it is actually spelled on disk"
        );
        std::fs::remove_dir_all(&scratch).unwrap();
    }
}
