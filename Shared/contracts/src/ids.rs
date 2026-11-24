//! Identifiers (row 1.13, owner decision 24 Nov 2026).
//!
//! Three things were one string. They are now three:
//!
//! * the **scene key**: the internal address of a scene (`SceneDocument.id`, a canonical file name; [`crate::TakeId`] carries the same
//!   value on the wire until the protocol is versioned). Never typed by a person, never shown as a name. Every reference (a cue, a rundown
//!   entry, a published revision, a binding) holds the key and the content hash, so renaming anything a person sees breaks no reference;
//! * the **Scene ID**: a label a person edits, shown in both applications (`SceneDocument.scene_label`). The first free number starting at
//!   1 is offered to a new scene. It is not an address: changing it changes nothing that points at the scene;
//! * the **Cue ID**: typed by the Playout operator, unique within a show, locked while its cue is on air. Other systems (TCP, UDP, HTTP,
//!   scripts) call a cue by it, so it is a name made of one run of characters with no space. Called a Take ID before 24 November 2026.
//!
//! The fixtures `fixtures/cue-ids.json` hold the rules for the pages that check them on their own side.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

use crate::{Refusal, TakeId};

/// Longest Cue ID or Scene ID, in characters.
pub const MOST_ID_CHARS: usize = 64;

/// Why a Cue ID or a Scene ID is not accepted. The words are the wire values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum IdFault {
    /// Nothing, or only spaces.
    Empty,
    /// More than [`MOST_ID_CHARS`] characters.
    TooLong,
    /// A character other than a letter of any script, a digit, or one of `. - _`: a Cue ID has no space, because a command line to
    /// Playout is split on spaces.
    BadCharacter,
    /// The first character is not a letter or a digit.
    BadStart,
}

impl std::fmt::Display for IdFault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Empty => "it is empty",
            Self::TooLong => "it is longer than 64 characters",
            Self::BadCharacter => "it may hold letters, digits and . - _ only, with no space",
            Self::BadStart => "it must start with a letter or a digit",
        })
    }
}

/// The rules for a Cue ID and a Scene ID: trimmed, 1 to 64 characters, letters of any script (with the marks that belong to them, so
/// Devanagari and Odia words are whole), digits and `. - _`, starting with a letter or a digit. The text is kept in Unicode form NFC, so the
/// same word typed two ways is one Cue ID.
pub fn check_id(input: &str) -> Result<String, IdFault> {
    let text: String = input.trim().nfc().collect();
    if text.is_empty() {
        return Err(IdFault::Empty);
    }
    if text.chars().count() > MOST_ID_CHARS {
        return Err(IdFault::TooLong);
    }
    if !text.chars().all(|c| c.is_alphanumeric() || is_combining_mark(c) || matches!(c, '.' | '-' | '_')) {
        return Err(IdFault::BadCharacter);
    }
    if !text.chars().next().is_some_and(char::is_alphanumeric) {
        return Err(IdFault::BadStart);
    }
    Ok(text)
}

/// The form two ids are compared in: NFC, lower case.
fn folded(text: &str) -> String {
    text.trim().nfc().collect::<String>().to_lowercase()
}

/// What a refusal shows of a typed text: cut short, with anything that is not printable written as `?`.
fn shown(text: &str) -> String {
    text.chars().take(MOST_ID_CHARS).map(|c| if c.is_control() { '?' } else { c }).collect()
}

/// A Cue ID that passed [`check_id`]. Deserialising checks it again, so a show file cannot hold one that the rules refuse.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(try_from = "String", into = "String")]
#[ts(type = "string")]
#[schemars(with = "String")]
pub struct CueId(String);

impl CueId {
    /// Check `input` and keep it as typed (trimmed). A refusal names the rule.
    pub fn parse(input: &str) -> Result<Self, Refusal> {
        match check_id(input) {
            Ok(text) => Ok(Self(text)),
            Err(fault) => Err(Refusal::CueIdInvalid { cue_id: shown(input), fault }),
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether two Cue IDs are the same one: other systems and operators do not tell `Open` from `open`, so the show does not either.
    pub fn same(&self, other: &str) -> bool {
        folded(&self.0) == folded(other)
    }
}

impl TryFrom<String> for CueId {
    type Error = String;
    fn try_from(value: String) -> Result<Self, String> {
        check_id(&value).map(Self).map_err(|fault| format!("a Cue ID is refused: {fault}"))
    }
}

impl From<CueId> for String {
    fn from(value: CueId) -> String {
        value.0
    }
}

impl std::fmt::Display for CueId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// One line of a show's cue table: the Cue ID and the scene it calls, by the scene's key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CueEntry {
    pub cue_id: CueId,
    /// The scene key (never the Scene ID).
    pub scene: TakeId,
    /// Set by Playout while this cue is on air; a Cue ID on air is locked.
    #[serde(default)]
    pub on_air: bool,
}

/// A show's Cue IDs (row 1.13): unique within the show (without regard to case), each calling one scene by its key, locked while on air.
/// Several Cue IDs may call the same scene.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CueTable {
    pub entries: Vec<CueEntry>,
}

impl CueTable {
    fn position(&self, cue: &str) -> Option<usize> {
        self.entries.iter().position(|e| e.cue_id.same(cue))
    }

    fn unknown(cue: &str) -> Refusal {
        Refusal::UnknownCueId { cue_id: shown(cue) }
    }

    fn locked(entry: &CueEntry) -> Refusal {
        Refusal::CueIdLockedOnAir { cue_id: entry.cue_id.to_string() }
    }

    fn duplicate(&self, cue: &CueId, except: Option<usize>) -> Result<(), Refusal> {
        match self.entries.iter().enumerate().find(|(i, e)| Some(*i) != except && e.cue_id.same(cue.as_str())) {
            Some((_, held)) => Err(Refusal::CueIdDuplicate { cue_id: cue.to_string(), held_by: held.scene.clone() }),
            None => Ok(()),
        }
    }

    /// Give the scene with key `scene` a Cue ID typed by the operator. A Cue ID the rules refuse, or one the show has already, is
    /// refused by name (a duplicate names the scene that holds it).
    pub fn assign(&mut self, typed: &str, scene: TakeId) -> Result<CueId, Refusal> {
        let cue = CueId::parse(typed)?;
        self.duplicate(&cue, None)?;
        self.entries.push(CueEntry { cue_id: cue.clone(), scene, on_air: false });
        Ok(cue)
    }

    /// Change a Cue ID. Refused while its cue is on air, and when the new one is refused by the rules or held by another cue.
    pub fn rename(&mut self, from: &str, to: &str) -> Result<CueId, Refusal> {
        let at = self.position(from).ok_or_else(|| Self::unknown(from))?;
        if self.entries[at].on_air {
            return Err(Self::locked(&self.entries[at]));
        }
        let cue = CueId::parse(to)?;
        self.duplicate(&cue, Some(at))?;
        self.entries[at].cue_id = cue.clone();
        Ok(cue)
    }

    /// Point a Cue ID at another scene (by key). Refused while the cue is on air.
    pub fn reassign(&mut self, cue: &str, scene: TakeId) -> Result<(), Refusal> {
        let at = self.position(cue).ok_or_else(|| Self::unknown(cue))?;
        if self.entries[at].on_air {
            return Err(Self::locked(&self.entries[at]));
        }
        self.entries[at].scene = scene;
        Ok(())
    }

    /// Take a Cue ID out of the show. Refused while its cue is on air.
    pub fn remove(&mut self, cue: &str) -> Result<CueEntry, Refusal> {
        let at = self.position(cue).ok_or_else(|| Self::unknown(cue))?;
        if self.entries[at].on_air {
            return Err(Self::locked(&self.entries[at]));
        }
        Ok(self.entries.remove(at))
    }

    /// Playout marks a cue on air, or off it. The lock follows.
    pub fn set_on_air(&mut self, cue: &str, on_air: bool) -> Result<(), Refusal> {
        let at = self.position(cue).ok_or_else(|| Self::unknown(cue))?;
        self.entries[at].on_air = on_air;
        Ok(())
    }

    /// The scene key a Cue ID calls (case does not matter, as for other systems that call it).
    pub fn scene_of(&self, cue: &str) -> Result<&TakeId, Refusal> {
        self.position(cue).map(|at| &self.entries[at].scene).ok_or_else(|| Self::unknown(cue))
    }

    /// The Cue IDs that call the scene with key `scene`.
    pub fn cues_of<'a>(&'a self, scene: &'a TakeId) -> impl Iterator<Item = &'a CueId> + 'a {
        self.entries.iter().filter(move |e| &e.scene == scene).map(|e| &e.cue_id)
    }

    /// Whether the show is whole: no Cue ID twice (without regard to case). Read from a file, so a hand-edited show is checked.
    pub fn check(&self) -> Result<(), Refusal> {
        for (at, entry) in self.entries.iter().enumerate() {
            self.duplicate(&entry.cue_id, Some(at))?;
        }
        Ok(())
    }
}

/// A Scene ID label (row 1.13): the same rules as a Cue ID. A refusal names the rule.
pub fn parse_scene_label(input: &str) -> Result<String, Refusal> {
    match check_id(input) {
        Ok(text) => Ok(text),
        Err(fault) => Err(Refusal::SceneLabelInvalid { label: shown(input), fault }),
    }
}

/// The Scene ID offered to a new scene: the lowest whole number from 1 that no scene of the project uses as its Scene ID.
pub fn next_scene_label<'a>(taken: impl IntoIterator<Item = &'a str>) -> String {
    let taken: std::collections::HashSet<String> = taken.into_iter().map(folded).collect();
    (1_u64..).map(|n| n.to_string()).find(|n| !taken.contains(n)).expect("an unbounded range has a free number")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(text: &str) -> TakeId {
        TakeId(text.into())
    }

    fn fixture() -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/cue-ids.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("the fixture is there")).expect("the fixture is JSON")
    }

    #[test]
    fn the_shared_fixture_holds_the_rules() {
        let write = std::env::var("GX_WRITE_FIXTURES").is_ok();
        let accepted = ["Open", "intro_1", "L3-left.2", "ସ୍ବାଗତ", "नमस्ते", "1", "a"];
        let longest = "x".repeat(MOST_ID_CHARS);
        let too_long = "x".repeat(MOST_ID_CHARS + 1);
        let refused: Vec<(String, &str)> = vec![
            ("".into(), "empty"),
            ("   ".into(), "empty"),
            (too_long.clone(), "tooLong"),
            ("two words".into(), "badCharacter"),
            ("tab\tid".into(), "badCharacter"),
            ("a/b".into(), "badCharacter"),
            ("-lead".into(), "badStart"),
            ("_lead".into(), "badStart"),
            (".lead".into(), "badStart"),
        ];
        let mut cases = Vec::new();
        for text in accepted.iter().map(|t| t.to_string()).chain([longest]) {
            cases.push(serde_json::json!({ "input": text, "accepted": true }));
        }
        cases.push(serde_json::json!({ "input": "  padded  ", "accepted": true, "trimmedTo": "padded" }));
        for (text, fault) in &refused {
            cases.push(serde_json::json!({ "input": text, "accepted": false, "fault": fault }));
        }
        let current = serde_json::json!({ "maxChars": MOST_ID_CHARS, "cases": cases });
        let text = serde_json::to_string_pretty(&current).unwrap() + "\n";
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/cue-ids.json");
        if write {
            std::fs::write(&path, &text).unwrap();
        }
        assert_eq!(fixture(), current, "run with GX_WRITE_FIXTURES=1 to rewrite fixtures/cue-ids.json");
        // And the code reads its own fixture the way a page would.
        for case in fixture()["cases"].as_array().unwrap() {
            let input = case["input"].as_str().unwrap();
            match (case["accepted"].as_bool().unwrap(), check_id(input)) {
                (true, Ok(text)) => {
                    if let Some(expected) = case["trimmedTo"].as_str() {
                        assert_eq!(text, expected);
                    }
                }
                (false, Err(fault)) => {
                    let word = serde_json::to_value(fault).unwrap();
                    assert_eq!(word, case["fault"], "{input:?}");
                }
                (accepted, got) => panic!("{input:?}: fixture says accepted={accepted}, code says {got:?}"),
            }
        }
    }

    #[test]
    fn a_cue_id_is_typed_checked_and_kept_as_typed() {
        assert_eq!(CueId::parse("  Open_1 ").unwrap().as_str(), "Open_1");
        // The same word typed as one character or as a letter and a mark is one Cue ID.
        let (composed, decomposed) = ("caf\u{e9}", "cafe\u{301}");
        assert_eq!(CueId::parse(decomposed).unwrap().as_str(), composed);
        let mut show = CueTable::default();
        show.assign(composed, key("s")).unwrap();
        assert!(matches!(show.assign(decomposed, key("t")), Err(Refusal::CueIdDuplicate { .. })));
        assert_eq!(
            CueId::parse("two words"),
            Err(Refusal::CueIdInvalid { cue_id: "two words".into(), fault: IdFault::BadCharacter })
        );
        assert!(matches!(CueId::parse("\u{7}bell"), Err(Refusal::CueIdInvalid { cue_id, .. }) if cue_id == "?bell"));
        let long = CueId::parse(&"y".repeat(500)).unwrap_err();
        assert!(matches!(long, Refusal::CueIdInvalid { cue_id, fault: IdFault::TooLong } if cue_id.chars().count() == MOST_ID_CHARS));
    }

    #[test]
    fn a_duplicate_cue_id_is_refused_by_name_without_regard_to_case() {
        let mut show = CueTable::default();
        show.assign("Open", key("scene-a")).unwrap();
        let refused = show.assign("open", key("scene-b")).unwrap_err();
        assert_eq!(refused, Refusal::CueIdDuplicate { cue_id: "open".into(), held_by: key("scene-a") });
        assert_eq!(show.entries.len(), 1, "a refused Cue ID leaves the show as it was");
        // Two Cue IDs may call one scene.
        show.assign("Open2", key("scene-a")).unwrap();
        assert_eq!(show.cues_of(&key("scene-a")).count(), 2);
    }

    #[test]
    fn a_cue_id_on_air_cannot_be_edited_and_can_once_it_is_off() {
        let mut show = CueTable::default();
        show.assign("Bug", key("scene-a")).unwrap();
        show.set_on_air("bug", true).unwrap();
        let locked = Refusal::CueIdLockedOnAir { cue_id: "Bug".into() };
        assert_eq!(show.rename("Bug", "Logo"), Err(locked.clone()));
        assert_eq!(show.reassign("Bug", key("scene-b")), Err(locked.clone()));
        assert_eq!(show.remove("Bug"), Err(locked));
        assert_eq!(show.scene_of("BUG").unwrap(), &key("scene-a"), "nothing changed while on air");
        show.set_on_air("Bug", false).unwrap();
        assert_eq!(show.rename("Bug", "Logo").unwrap().as_str(), "Logo");
        assert_eq!(show.scene_of("logo").unwrap(), &key("scene-a"));
        assert_eq!(show.scene_of("Bug"), Err(Refusal::UnknownCueId { cue_id: "Bug".into() }));
    }

    #[test]
    fn renaming_a_cue_id_to_another_cues_is_refused_and_to_its_own_case_is_not() {
        let mut show = CueTable::default();
        show.assign("One", key("scene-a")).unwrap();
        show.assign("Two", key("scene-b")).unwrap();
        assert!(matches!(show.rename("One", "TWO"), Err(Refusal::CueIdDuplicate { held_by, .. }) if held_by == key("scene-b")));
        assert_eq!(show.rename("One", "ONE").unwrap().as_str(), "ONE");
        assert!(matches!(show.rename("One", "bad id"), Err(Refusal::CueIdInvalid { .. })));
        assert!(matches!(show.rename("Nine", "Ten"), Err(Refusal::UnknownCueId { .. })));
    }

    #[test]
    fn a_show_file_with_a_refused_cue_id_does_not_load() {
        let text = r#"{"entries":[{"cueId":"fine","scene":"s1"},{"cueId":"not fine","scene":"s2"}]}"#;
        let err = serde_json::from_str::<CueTable>(text).unwrap_err().to_string();
        assert!(err.contains("a Cue ID is refused"), "{err}");
        let twice = r#"{"entries":[{"cueId":"Same","scene":"s1"},{"cueId":"same","scene":"s2"}]}"#;
        let show: CueTable = serde_json::from_str(twice).unwrap();
        assert!(matches!(show.check(), Err(Refusal::CueIdDuplicate { .. })), "the check finds what the parse cannot");
        let ok: CueTable = serde_json::from_str(r#"{"entries":[{"cueId":"fine","scene":"s1","onAir":true}]}"#).unwrap();
        assert!(ok.check().is_ok() && ok.entries[0].on_air);
        let back = serde_json::to_string(&ok).unwrap();
        assert_eq!(serde_json::from_str::<CueTable>(&back).unwrap(), ok);
    }

    #[test]
    fn the_scene_id_is_a_label_the_first_free_number_is_offered_and_the_rules_apply() {
        assert_eq!(next_scene_label([]), "1");
        assert_eq!(next_scene_label(["1", "2", "4"]), "3");
        assert_eq!(next_scene_label(["2", "Lower third"]), "1");
        assert_eq!(parse_scene_label(" 12 ").unwrap(), "12");
        assert_eq!(
            parse_scene_label("a b"),
            Err(Refusal::SceneLabelInvalid { label: "a b".into(), fault: IdFault::BadCharacter })
        );
    }
}
