//! Bulk Cue ID suggestion with a preview diff (row 12.15).
//!
//! The operator asks for Cue IDs for many rundown entries at once. [`CueTable::suggest`] only *reads*: it answers with a [`CuePlan`], a
//! line per entry saying what would change (add, rename, unchanged) or why a line is refused, by name. Nothing is renamed by it.
//! [`CueTable::apply_plan`] is the confirmation: it works the plan out again against the table as it is now and applies it only when it is
//! exactly the plan the operator saw and no line is refused, all or nothing. A table that changed in between (a cue went on air, another
//! operator typed a Cue ID) makes the plan stale and refuses it by name; so does a plan whose lines were edited on the way back.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ids::{CueEntry, CueId, CueTable, MOST_ID_CHARS};
use crate::{Refusal, TakeId};

/// Most entries one bulk suggestion covers.
pub const MOST_BULK_CUES: usize = 500;

/// How the suggestions are made.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CueNaming {
    /// `prefix` then a number: the first entry gets `start`, the next `start + step`, and so on, padded with zeros to `pad` digits
    /// (`L3-` from 1 with pad 2 gives `L3-01`, `L3-02`).
    #[serde(rename_all = "camelCase")]
    Numbered { prefix: String, start: u32, step: u32, pad: u8 },
    /// From each entry's own name: spaces become `-` (a run of them one), anything a Cue ID may not hold is dropped, cut to 64 characters.
    FromNames,
}

/// One rundown entry a suggestion is wanted for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SuggestTarget {
    /// The scene key the entry calls.
    pub scene: TakeId,
    /// What the operator sees the entry called.
    pub name: String,
    /// The entry's Cue ID now, which a suggestion renames; absent for an entry that has none, which a suggestion adds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cue: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SuggestRequest {
    pub targets: Vec<SuggestTarget>,
    pub naming: CueNaming,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DiffKind {
    /// The entry had no Cue ID and gets one.
    Add,
    /// The entry has a Cue ID and it changes.
    Rename,
    /// The suggestion is the Cue ID the entry has.
    Unchanged,
    /// The line cannot be applied; `refusal` says why.
    Refused,
}

/// One line of the preview diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CueDiffLine {
    /// The place of the entry in the request.
    pub index: u32,
    pub scene: TakeId,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<String>,
    /// The suggestion (for a refused line, as far as it could be made).
    pub to: String,
    pub kind: DiffKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub refusal: Option<Refusal>,
}

/// What the operator is shown and confirms. It carries the request, so the confirmation can be checked against it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CuePlan {
    pub request: SuggestRequest,
    pub lines: Vec<CueDiffLine>,
}

impl CuePlan {
    /// Whether every line can be applied.
    pub fn is_clean(&self) -> bool {
        self.lines.iter().all(|l| l.kind != DiffKind::Refused)
    }

    /// How many lines change the show.
    pub fn changes(&self) -> usize {
        self.lines.iter().filter(|l| matches!(l.kind, DiffKind::Add | DiffKind::Rename)).count()
    }
}

fn invalid(field: String, detail: &str) -> Refusal {
    Refusal::ObjectFieldValueInvalid { field, detail: detail.into() }
}

/// The text the naming gives the entry at `index`, before the rules of a Cue ID are applied to it.
fn proposed_text(naming: &CueNaming, index: usize, target: &SuggestTarget) -> String {
    match naming {
        CueNaming::Numbered { prefix, start, step, pad } => {
            let number = u64::from(*start) + u64::from(*step) * index as u64;
            format!("{prefix}{number:0width$}", width = usize::from(*pad))
        }
        CueNaming::FromNames => {
            let slug: String = target
                .name
                .trim()
                .chars()
                .map(|c| if c.is_whitespace() { '-' } else { c })
                .filter(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_') || unicode_normalization::char::is_combining_mark(*c))
                .collect();
            // A run of hyphens (a dropped character between two spaces) is one.
            let mut out = String::new();
            for c in slug.chars() {
                if !(c == '-' && out.ends_with('-')) {
                    out.push(c);
                }
            }
            out.chars().take(MOST_ID_CHARS).collect()
        }
    }
}

impl CueTable {
    /// Work out what a bulk suggestion would do, without doing any of it. A request that is not usable at all (too many entries) is refused;
    /// every other problem is a refused *line*, so the operator sees all of them at once.
    pub fn suggest(&self, request: &SuggestRequest) -> Result<CuePlan, Refusal> {
        if request.targets.len() > MOST_BULK_CUES {
            return Err(invalid("targets".into(), &format!("a bulk suggestion covers at most {MOST_BULK_CUES} entries")));
        }
        let n = request.targets.len();
        // What each entry would be given, by the rules of a Cue ID.
        let proposals: Vec<Result<CueId, Refusal>> = request
            .targets
            .iter()
            .enumerate()
            .map(|(i, t)| CueId::parse(&proposed_text(&request.naming, i, t)))
            .collect();
        // Where each entry's current Cue ID is in the table, if it has one the table knows.
        let at: Vec<Option<usize>> = request
            .targets
            .iter()
            .map(|t| t.cue.as_deref().and_then(|c| self.entries.iter().position(|e| e.cue_id.same(c))))
            .collect();

        let mut lines: Vec<CueDiffLine> = Vec::new();
        // A name an entry gives up (it is renamed in this plan) is free for another to take, so the lines are worked out again until they
        // stop changing; a swap of two Cue IDs needs the second pass.
        let mut leaving: Vec<bool> = (0..n).map(|i| at[i].is_some() && proposals[i].is_ok()).collect();
        for _ in 0..n + 2 {
            let mut pass: Vec<CueDiffLine> = Vec::with_capacity(n);
            for i in 0..n {
                let line = self.line(request, i, &proposals, &at, &leaving, &pass);
                pass.push(line);
            }
            lines = pass;
            let next: Vec<bool> = lines.iter().map(|l| l.kind == DiffKind::Rename).collect();
            if next == leaving {
                break;
            }
            leaving = next;
        }
        Ok(CuePlan { request: request.clone(), lines })
    }

    /// The line for entry `i`, given which entries give up their Cue IDs (`leaving`) and the lines of the entries before it.
    fn line(
        &self,
        request: &SuggestRequest,
        i: usize,
        proposals: &[Result<CueId, Refusal>],
        at: &[Option<usize>],
        leaving: &[bool],
        earlier: &[CueDiffLine],
    ) -> CueDiffLine {
        let target = &request.targets[i];
        let from = target
            .cue
            .as_ref()
            .map(|c| at[i].map(|a| self.entries[a].cue_id.to_string()).unwrap_or_else(|| c.chars().take(MOST_ID_CHARS).collect()));
        let shown_to = match &proposals[i] {
            Ok(cue) => cue.to_string(),
            Err(_) => proposed_text(&request.naming, i, target).chars().take(MOST_ID_CHARS).collect(),
        };
        let refuse = |refusal: Refusal| CueDiffLine {
            index: i as u32,
            scene: target.scene.clone(),
            name: target.name.clone(),
            from: from.clone(),
            to: shown_to.clone(),
            kind: DiffKind::Refused,
            refusal: Some(refusal),
        };
        let done = |kind: DiffKind| CueDiffLine {
            index: i as u32,
            scene: target.scene.clone(),
            name: target.name.clone(),
            from: from.clone(),
            to: shown_to.clone(),
            kind,
            refusal: None,
        };
        // The entry's own Cue ID: it must exist, be off air, and be named once in the request.
        if let Some(cue) = &target.cue {
            let Some(held) = at[i] else {
                return refuse(Refusal::UnknownCueId { cue_id: cue.chars().take(MOST_ID_CHARS).collect() });
            };
            if request.targets[..i].iter().enumerate().any(|(j, t)| at[j] == Some(held) && t.cue.is_some()) {
                return refuse(invalid(format!("targets[{i}].cue"), "this Cue ID is named twice in the request"));
            }
            if self.entries[held].on_air {
                return refuse(Refusal::CueIdLockedOnAir { cue_id: self.entries[held].cue_id.to_string() });
            }
        }
        let cue = match &proposals[i] {
            Ok(cue) => cue,
            Err(refusal) => return refuse(refusal.clone()),
        };
        if target.cue.is_some() && at[i].is_some_and(|a| self.entries[a].cue_id.same(cue.as_str())) {
            return done(DiffKind::Unchanged);
        }
        // A Cue ID another entry of the show holds, unless that entry gives it up in this plan.
        for (e, entry) in self.entries.iter().enumerate() {
            if !entry.cue_id.same(cue.as_str()) {
                continue;
            }
            let gives_it_up = (0..request.targets.len()).any(|j| at[j] == Some(e) && leaving[j]);
            if !gives_it_up {
                return refuse(Refusal::CueIdDuplicate { cue_id: cue.to_string(), held_by: entry.scene.clone() });
            }
        }
        // A Cue ID an entry before this one is given in this plan.
        if let Some(first) = earlier.iter().find(|l| matches!(l.kind, DiffKind::Add | DiffKind::Rename) && cue.same(&l.to)) {
            return refuse(Refusal::CueIdDuplicate { cue_id: cue.to_string(), held_by: first.scene.clone() });
        }
        done(if target.cue.is_some() { DiffKind::Rename } else { DiffKind::Add })
    }

    /// The confirmation. The plan is worked out again against the show as it is now; it is applied only if it is the plan that was shown and
    /// no line of it is refused, all of it or none of it. Returns how many entries changed.
    pub fn apply_plan(&mut self, plan: &CuePlan) -> Result<usize, Refusal> {
        let fresh = self.suggest(&plan.request)?;
        if fresh.lines != plan.lines {
            return Err(Refusal::CuePlanStale);
        }
        if let Some(refused) = plan.lines.iter().find_map(|l| l.refusal.clone()) {
            return Err(refused);
        }
        let mut next = self.clone();
        for (line, target) in plan.lines.iter().zip(&plan.request.targets) {
            match line.kind {
                DiffKind::Rename => {
                    let cue = target.cue.as_deref().expect("a renamed line has a Cue ID");
                    let at = self.entries.iter().position(|e| e.cue_id.same(cue)).expect("the plan was checked against this show");
                    next.entries[at].cue_id = CueId::parse(&line.to)?;
                }
                DiffKind::Add => next.entries.push(CueEntry { cue_id: CueId::parse(&line.to)?, scene: line.scene.clone(), on_air: false }),
                DiffKind::Unchanged | DiffKind::Refused => {}
            }
        }
        next.check()?;
        let changed = plan.changes();
        *self = next;
        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(text: &str) -> TakeId {
        TakeId(text.into())
    }

    fn target(scene: &str, name: &str, cue: Option<&str>) -> SuggestTarget {
        SuggestTarget { scene: key(scene), name: name.into(), cue: cue.map(Into::into) }
    }

    fn numbered(prefix: &str, start: u32, pad: u8) -> CueNaming {
        CueNaming::Numbered { prefix: prefix.into(), start, step: 1, pad }
    }

    fn show(cues: &[(&str, &str)]) -> CueTable {
        let mut table = CueTable::default();
        for (cue, scene) in cues {
            table.assign(cue, key(scene)).unwrap();
        }
        table
    }

    #[test]
    fn a_suggestion_shows_a_diff_and_changes_nothing_until_it_is_confirmed() {
        let mut table = show(&[("old-1", "s1")]);
        let before = table.clone();
        let request = SuggestRequest {
            targets: vec![target("s1", "Opener", Some("old-1")), target("s2", "Bug", None), target("s3", "Strap", None)],
            naming: numbered("L3-", 1, 2),
        };
        let plan = table.suggest(&request).unwrap();
        assert_eq!(table, before, "asking for a preview renames nothing");
        let kinds: Vec<_> = plan.lines.iter().map(|l| (l.from.as_deref(), l.to.as_str(), l.kind)).collect();
        assert_eq!(
            kinds,
            vec![
                (Some("old-1"), "L3-01", DiffKind::Rename),
                (None, "L3-02", DiffKind::Add),
                (None, "L3-03", DiffKind::Add)
            ]
        );
        assert!(plan.is_clean() && plan.changes() == 3);
        assert_eq!(table.apply_plan(&plan).unwrap(), 3);
        assert_eq!(table.scene_of("l3-01").unwrap(), &key("s1"), "the renamed cue still calls its scene");
        assert_eq!(table.scene_of("L3-03").unwrap(), &key("s3"));
        assert!(table.scene_of("old-1").is_err());
    }

    #[test]
    fn a_duplicate_is_a_refused_line_by_name_and_the_whole_confirmation_is_refused() {
        let mut table = show(&[("L3-02", "taken-scene")]);
        let request = SuggestRequest { targets: vec![target("s1", "A", None), target("s2", "B", None)], naming: numbered("L3-", 1, 2) };
        let plan = table.suggest(&request).unwrap();
        assert_eq!(plan.lines[0].kind, DiffKind::Add);
        assert_eq!(plan.lines[1].kind, DiffKind::Refused);
        assert_eq!(plan.lines[1].refusal, Some(Refusal::CueIdDuplicate { cue_id: "L3-02".into(), held_by: key("taken-scene") }));
        assert!(!plan.is_clean());
        let before = table.clone();
        assert_eq!(table.apply_plan(&plan), Err(Refusal::CueIdDuplicate { cue_id: "L3-02".into(), held_by: key("taken-scene") }));
        assert_eq!(table, before, "all or nothing: the clean line was not applied either");
    }

    #[test]
    fn two_entries_given_the_same_suggestion_are_refused_for_the_second() {
        let table = CueTable::default();
        let request = SuggestRequest {
            targets: vec![target("s1", "Same", None), target("s2", "same", None)],
            naming: CueNaming::FromNames,
        };
        let plan = table.suggest(&request).unwrap();
        assert_eq!(plan.lines[0].kind, DiffKind::Add);
        assert_eq!(plan.lines[1].refusal, Some(Refusal::CueIdDuplicate { cue_id: "same".into(), held_by: key("s1") }));
    }

    #[test]
    fn two_cues_can_swap_names_because_each_gives_its_name_up() {
        let mut table = show(&[("A", "sa"), ("B", "sb")]);
        let request = SuggestRequest {
            targets: vec![target("sa", "B", Some("A")), target("sb", "A", Some("B"))],
            naming: CueNaming::FromNames,
        };
        let plan = table.suggest(&request).unwrap();
        assert!(plan.is_clean(), "{:?}", plan.lines);
        assert_eq!(table.apply_plan(&plan).unwrap(), 2);
        assert_eq!(table.scene_of("A").unwrap(), &key("sb"));
        assert_eq!(table.scene_of("B").unwrap(), &key("sa"));
    }

    #[test]
    fn a_cue_on_air_an_unknown_cue_and_a_cue_named_twice_are_refused_lines() {
        let mut table = show(&[("live", "s1"), ("idle", "s2")]);
        table.set_on_air("live", true).unwrap();
        let request = SuggestRequest {
            targets: vec![
                target("s1", "x", Some("live")),
                target("s9", "y", Some("ghost")),
                target("s2", "z", Some("idle")),
                target("s2", "z", Some("IDLE")),
            ],
            naming: numbered("N", 1, 0),
        };
        let plan = table.suggest(&request).unwrap();
        assert_eq!(plan.lines[0].refusal, Some(Refusal::CueIdLockedOnAir { cue_id: "live".into() }));
        assert_eq!(plan.lines[1].refusal, Some(Refusal::UnknownCueId { cue_id: "ghost".into() }));
        assert_eq!(plan.lines[2].kind, DiffKind::Rename);
        assert!(matches!(&plan.lines[3].refusal, Some(Refusal::ObjectFieldValueInvalid { field, .. }) if field == "targets[3].cue"));
    }

    #[test]
    fn an_unchanged_line_changes_nothing_and_a_refused_prefix_is_a_refused_line() {
        let table = show(&[("L3-01", "s1")]);
        let request = SuggestRequest { targets: vec![target("s1", "A", Some("l3-01"))], naming: numbered("L3-", 1, 2) };
        let plan = table.suggest(&request).unwrap();
        assert_eq!(plan.lines[0].kind, DiffKind::Unchanged);
        assert_eq!(plan.changes(), 0);
        let bad = SuggestRequest { targets: vec![target("s1", "A", None)], naming: numbered("two words ", 1, 0) };
        let plan = table.suggest(&bad).unwrap();
        assert!(matches!(plan.lines[0].refusal, Some(Refusal::CueIdInvalid { .. })));
        assert_eq!(plan.lines[0].to, "two words 1", "the refused line still shows what was meant");
    }

    #[test]
    fn a_table_that_changed_after_the_preview_makes_the_plan_stale() {
        let mut table = show(&[("a", "s1")]);
        let request = SuggestRequest { targets: vec![target("s2", "B", None)], naming: numbered("N", 1, 0) };
        let plan = table.suggest(&request).unwrap();
        // Someone else takes the suggested Cue ID before the operator confirms.
        table.assign("N1", key("s7")).unwrap();
        let before = table.clone();
        assert_eq!(table.apply_plan(&plan), Err(Refusal::CuePlanStale));
        assert_eq!(table, before);
        // A cue going on air changes a plan that renamed it.
        let mut table = show(&[("a", "s1")]);
        let plan = table.suggest(&SuggestRequest { targets: vec![target("s1", "A", Some("a"))], naming: numbered("N", 1, 0) }).unwrap();
        table.set_on_air("a", true).unwrap();
        assert_eq!(table.apply_plan(&plan), Err(Refusal::CuePlanStale));
    }

    #[test]
    fn a_plan_edited_on_the_way_back_is_not_applied() {
        let mut table = CueTable::default();
        let request = SuggestRequest { targets: vec![target("s1", "A", None)], naming: numbered("N", 1, 0) };
        let mut plan = table.suggest(&request).unwrap();
        plan.lines[0].to = "SomethingElse".into();
        assert_eq!(table.apply_plan(&plan), Err(Refusal::CuePlanStale));
        assert!(table.entries.is_empty());
        // And a plan that says a refused line is fine is not believed.
        let mut table = show(&[("N1", "s0")]);
        let mut plan = table.suggest(&request).unwrap();
        plan.lines[0].kind = DiffKind::Add;
        plan.lines[0].refusal = None;
        assert_eq!(table.apply_plan(&plan), Err(Refusal::CuePlanStale));
        assert_eq!(table.entries.len(), 1);
    }

    #[test]
    fn names_become_cue_ids_and_a_bulk_request_has_a_size_limit() {
        let table = CueTable::default();
        let request = SuggestRequest {
            targets: vec![target("s1", "  Lower Third: Home / Away  ", None), target("s2", "!!!", None)],
            naming: CueNaming::FromNames,
        };
        let plan = table.suggest(&request).unwrap();
        assert_eq!(plan.lines[0].to, "Lower-Third-Home-Away", "{:?}", plan.lines[0]);
        assert!(matches!(plan.lines[1].refusal, Some(Refusal::CueIdInvalid { fault: crate::ids::IdFault::Empty, .. })));
        let many = SuggestRequest { targets: (0..=MOST_BULK_CUES).map(|i| target(&format!("s{i}"), "n", None)).collect(), naming: numbered("N", 1, 0) };
        assert!(matches!(table.suggest(&many), Err(Refusal::ObjectFieldValueInvalid { .. })));
        let edge = SuggestRequest { targets: (0..MOST_BULK_CUES).map(|i| target(&format!("s{i}"), "n", None)).collect(), naming: numbered("N", 1, 0) };
        let plan = table.suggest(&edge).unwrap();
        assert!(plan.is_clean());
        let mut table = table;
        assert_eq!(table.apply_plan(&plan).unwrap(), MOST_BULK_CUES);
    }

    #[test]
    fn a_plan_travels_as_json() {
        let table = show(&[("old", "s1")]);
        let request = SuggestRequest { targets: vec![target("s1", "A", Some("old"))], naming: numbered("N", 1, 0) };
        let plan = table.suggest(&request).unwrap();
        let text = serde_json::to_string(&plan).unwrap();
        assert!(text.contains(r#""kind":"rename""#) && text.contains(r#""naming":{"kind":"numbered""#), "{text}");
        let back: CuePlan = serde_json::from_str(&text).unwrap();
        assert_eq!(back, plan);
    }
}
