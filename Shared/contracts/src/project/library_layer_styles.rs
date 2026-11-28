//! Project-local Library layer styles (plan row 11.122, the Layer styles tab). A library layer style is a named, ordered stack of the effects
//! the engine renders (drop shadow, glow and the rest of the catalogue), kept in the project with their static settings and enabled
//! switches. Applying one to a graphic COPIES the effects into the object, so nothing links a graphic to the library: editing or deleting a
//! library style never changes a graphic (asked of Jev and Laya first, `docs/evidence/11.122/jev-laya-layer-styles.json`).
//!
//! What a style does not keep, by design: keyframes (a style holds the settings an effect has now) and the limits an effect has to the masks
//! of the object it came from (a mask belongs to one object, so its id means nothing in another). Photoshop's inner shadow, bevel,
//! gradient overlay and stroke style are not effects the engine has (row 11.60), so a style cannot contain them.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::effect::{validate_effects, EffectInstance};

/// Most layer styles one project's library holds.
pub const MOST_STYLES: usize = 200;
/// Most effects one style holds.
pub const MOST_EFFECTS: usize = 32;
/// Longest name, in characters.
pub const LONGEST_NAME: usize = 64;

/// One named effect stack in the project's library.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryLayerStyle {
    pub id: String,
    pub name: String,
    pub effects: Vec<EffectInstance>,
}

/// The project's library layer styles, in the order they were made.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryLayerStyles {
    #[serde(default)]
    pub styles: Vec<LibraryLayerStyle>,
    #[serde(default)]
    next_style_sequence: u64,
}

/// Whether an effect stack can be kept as a style: 1 to 32 effects, every one valid as the engine requires of an object's stack (unique ids,
/// every setting in its domain), none limited to a mask.
pub fn check_effects(effects: &[EffectInstance]) -> Result<(), String> {
    if effects.is_empty() || effects.len() > MOST_EFFECTS {
        return Err(format!("a layer style holds 1 to {MOST_EFFECTS} effects, not {}", effects.len()));
    }
    if let Some(limited) = effects.iter().find(|instance| instance.mask_ids.as_ref().is_some_and(|ids| !ids.is_empty())) {
        return Err(format!(
            "effect {} is limited to a mask of one object: a layer style cannot keep that, because a mask belongs to one object",
            limited.effect_id
        ));
    }
    validate_effects("a library layer style", effects).map_err(|refusal| refusal.to_string())
}

impl LibraryLayerStyles {
    /// No style was ever made: nothing to write.
    pub fn is_untouched(&self) -> bool {
        self.styles.is_empty() && self.next_style_sequence == 0
    }

    pub fn create_named(&mut self, name: &str, effects: Vec<EffectInstance>) -> Result<String, String> {
        if self.styles.len() >= MOST_STYLES {
            return Err(format!("a project's library holds at most {MOST_STYLES} layer styles"));
        }
        let name = self.check_name(None, name)?.to_owned();
        check_effects(&effects)?;
        let mut sequence = self.next_style_sequence;
        loop {
            sequence = sequence.checked_add(1).ok_or("Library layer style IDs exhausted")?;
            let id = format!("style-{sequence}");
            if self.styles.iter().any(|existing| existing.id == id) {
                continue;
            }
            self.next_style_sequence = sequence;
            self.styles.push(LibraryLayerStyle { id: id.clone(), name, effects });
            return Ok(id);
        }
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Result<(), String> {
        let index = self.index(id)?;
        let name = self.check_name(Some(id), name)?.to_owned();
        self.styles[index].name = name;
        Ok(())
    }

    /// Replace the style's effects. A refused stack leaves the style as it was.
    pub fn set_effects(&mut self, id: &str, effects: Vec<EffectInstance>) -> Result<(), String> {
        let index = self.index(id)?;
        check_effects(&effects)?;
        self.styles[index].effects = effects;
        Ok(())
    }

    /// Remove the style. Graphics keep the effects they were given: nothing links them to it.
    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        let index = self.index(id)?;
        self.styles.remove(index);
        Ok(())
    }

    pub(crate) fn check(&self) -> Result<(), String> {
        if self.styles.len() > MOST_STYLES {
            return Err(format!("a project's library holds at most {MOST_STYLES} layer styles"));
        }
        for (position, style) in self.styles.iter().enumerate() {
            if style.id.trim().is_empty() || self.styles[..position].iter().any(|earlier| earlier.id == style.id) {
                return Err(format!("invalid or duplicate Library layer style ID {:?}", style.id));
            }
            self.check_name(Some(&style.id), &style.name)?;
            check_effects(&style.effects).map_err(|why| format!("Library layer style {:?}: {why}", style.name))?;
        }
        Ok(())
    }

    fn index(&self, id: &str) -> Result<usize, String> {
        self.styles.iter().position(|style| style.id == id).ok_or_else(|| format!("unknown Library layer style {id:?}"))
    }

    /// A name of 1 to 64 characters with no control character, unique in the project ignoring case (the style `except` may keep its own).
    fn check_name<'a>(&self, except: Option<&str>, name: &'a str) -> Result<&'a str, String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > LONGEST_NAME || name.chars().any(char::is_control) {
            return Err(format!("a Library layer style's name is 1 to {LONGEST_NAME} characters with no control character, not {name:?}"));
        }
        let folded = name.to_lowercase();
        if self.styles.iter().any(|style| Some(style.id.as_str()) != except && style.name.to_lowercase() == folded) {
            return Err(format!("a Library layer style named {name:?} already exists"));
        }
        Ok(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effect::{DropShadow, Effect, Glow};

    fn shadow() -> EffectInstance {
        EffectInstance::new("drop-shadow", Effect::DropShadow(DropShadow::default()))
    }

    fn glow() -> EffectInstance {
        EffectInstance::new("glow", Effect::Glow(Glow::default()))
    }

    #[test]
    fn styles_are_made_in_order_with_their_own_ids_and_names_trimmed() {
        let mut library = LibraryLayerStyles::default();
        assert_eq!(library.create_named("  Soft shadow ", vec![shadow()]).unwrap(), "style-1");
        assert_eq!(library.create_named("Neon", vec![glow(), shadow()]).unwrap(), "style-2");
        assert_eq!(library.styles.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Soft shadow", "Neon"]);
        assert_eq!(library.styles[1].effects.iter().map(|e| e.effect_id.as_str()).collect::<Vec<_>>(), ["glow", "drop-shadow"], "the order is kept");
        library.check().unwrap();
    }

    #[test]
    fn an_id_is_not_reused_after_a_delete() {
        let mut library = LibraryLayerStyles::default();
        library.create_named("A", vec![shadow()]).unwrap();
        library.create_named("B", vec![shadow()]).unwrap();
        library.delete("style-2").unwrap();
        assert_eq!(library.create_named("C", vec![shadow()]).unwrap(), "style-3");
    }

    #[test]
    fn a_name_is_unique_ignoring_case_and_refused_by_name() {
        let mut library = LibraryLayerStyles::default();
        library.create_named("Soft shadow", vec![shadow()]).unwrap();
        assert!(library.create_named("SOFT SHADOW", vec![shadow()]).unwrap_err().contains("already exists"));
        library.create_named("Neon", vec![glow()]).unwrap();
        assert!(library.rename("style-2", "soft shadow").unwrap_err().contains("already exists"));
        // A style may keep its own name, in other letters.
        library.rename("style-1", "SOFT SHADOW").unwrap();
        assert_eq!(library.styles[0].name, "SOFT SHADOW");
    }

    #[test]
    fn a_name_is_one_to_sixty_four_characters_without_control_characters() {
        let mut library = LibraryLayerStyles::default();
        for bad in ["", "   ", "tab\there", "line\nbreak"] {
            assert!(library.create_named(bad, vec![shadow()]).unwrap_err().contains("1 to 64 characters"), "{bad:?}");
        }
        assert!(library.create_named(&"x".repeat(65), vec![shadow()]).is_err());
        assert!(library.create_named(&"x".repeat(64), vec![shadow()]).is_ok());
        assert!(library.create_named(&"\u{00e9}".repeat(64), vec![shadow()]).is_ok(), "characters, not bytes");
    }

    #[test]
    fn a_style_holds_one_to_thirty_two_effects() {
        let mut library = LibraryLayerStyles::default();
        assert!(library.create_named("Empty", vec![]).unwrap_err().contains("1 to 32 effects"));
        let many = |count: usize| (0..count).map(|n| EffectInstance::new(format!("shadow-{n}"), Effect::DropShadow(DropShadow::default()))).collect::<Vec<_>>();
        assert!(library.create_named("Too many", many(33)).unwrap_err().contains("1 to 32 effects, not 33"));
        library.create_named("Most", many(32)).unwrap();
    }

    #[test]
    fn the_effects_must_be_ones_the_engine_accepts() {
        let mut library = LibraryLayerStyles::default();
        let twice = library.create_named("Twice", vec![shadow(), shadow()]).unwrap_err();
        assert!(twice.contains("used twice"), "{twice}");
        let mut out_of_range = DropShadow::default();
        out_of_range.opacity = 7.0;
        let bad = EffectInstance::new("drop-shadow", Effect::DropShadow(out_of_range));
        assert!(library.create_named("Loud", vec![bad]).unwrap_err().contains("opacity"));
        let mut dotted = shadow();
        dotted.effect_id = "a.b".into();
        assert!(library.create_named("Dotted", vec![dotted]).unwrap_err().contains("effectId"));
        assert!(library.styles.is_empty(), "a refused style writes nothing");
    }

    #[test]
    fn an_effect_limited_to_a_mask_is_refused_by_name_because_a_mask_belongs_to_one_object() {
        let mut library = LibraryLayerStyles::default();
        let mut limited = shadow();
        limited.mask_ids = Some(vec!["mask-1".into()]);
        let why = library.create_named("Limited", vec![limited]).unwrap_err();
        assert!(why.contains("effect drop-shadow is limited to a mask"), "{why}");
        // An empty list of masks limits nothing.
        let mut unlimited = shadow();
        unlimited.mask_ids = Some(vec![]);
        library.create_named("Unlimited", vec![unlimited]).unwrap();
    }

    #[test]
    fn replacing_the_effects_of_a_style_is_refused_whole_and_leaves_it_as_it_was() {
        let mut library = LibraryLayerStyles::default();
        let id = library.create_named("Soft shadow", vec![shadow()]).unwrap();
        library.set_effects(&id, vec![glow(), shadow()]).unwrap();
        assert_eq!(library.styles[0].effects.len(), 2);
        assert!(library.set_effects(&id, vec![]).is_err());
        assert!(library.set_effects(&id, vec![shadow(), shadow()]).is_err());
        assert_eq!(library.styles[0].effects.len(), 2, "a refused change leaves the style as it was");
    }

    #[test]
    fn an_unknown_style_is_refused_by_name() {
        let mut library = LibraryLayerStyles::default();
        for result in [library.rename("style-9", "X"), library.set_effects("style-9", vec![shadow()]), library.delete("style-9")] {
            assert_eq!(result.unwrap_err(), "unknown Library layer style \"style-9\"");
        }
    }

    #[test]
    fn a_library_holds_at_most_two_hundred_styles() {
        let mut library = LibraryLayerStyles::default();
        for number in 0..MOST_STYLES {
            library.create_named(&format!("s{number}"), vec![shadow()]).unwrap();
        }
        assert!(library.create_named("one more", vec![shadow()]).unwrap_err().contains("at most 200"));
        library.delete("style-1").unwrap();
        library.create_named("one more", vec![shadow()]).unwrap();
    }

    #[test]
    fn a_stored_library_is_checked_when_the_project_is_opened() {
        let mut library = LibraryLayerStyles::default();
        library.create_named("A", vec![shadow()]).unwrap();
        library.create_named("B", vec![glow()]).unwrap();
        library.check().unwrap();
        let mut duplicate_id = library.clone();
        duplicate_id.styles[1].id = "style-1".into();
        assert!(duplicate_id.check().unwrap_err().contains("duplicate Library layer style ID"));
        let mut duplicate_name = library.clone();
        duplicate_name.styles[1].name = "a".into();
        assert!(duplicate_name.check().unwrap_err().contains("already exists"));
        let mut no_effects = library.clone();
        no_effects.styles[0].effects.clear();
        assert!(no_effects.check().unwrap_err().contains("Library layer style \"A\""));
        let mut limited = library;
        limited.styles[1].effects[0].mask_ids = Some(vec!["mask-1".into()]);
        assert!(limited.check().unwrap_err().contains("limited to a mask"));
    }

    #[test]
    fn a_library_nobody_used_is_not_written_but_one_that_was_is_kept_empty() {
        let mut library = LibraryLayerStyles::default();
        assert!(library.is_untouched());
        library.create_named("A", vec![shadow()]).unwrap();
        assert!(!library.is_untouched());
        library.delete("style-1").unwrap();
        // Emptied, it still remembers how far its ids went, so an id is not handed out twice.
        assert!(!library.is_untouched());
        assert_eq!(library.create_named("B", vec![shadow()]).unwrap(), "style-2");
    }

    #[test]
    fn it_round_trips_through_json_and_an_older_project_reads_without_it() {
        let mut library = LibraryLayerStyles::default();
        library.create_named("Neon", vec![glow(), shadow()]).unwrap();
        let json = serde_json::to_string(&library).unwrap();
        assert_eq!(serde_json::from_str::<LibraryLayerStyles>(&json).unwrap(), library);
        assert_eq!(serde_json::from_str::<LibraryLayerStyles>("{}").unwrap(), LibraryLayerStyles::default());
        assert!(serde_json::from_str::<LibraryLayerStyles>(r#"{"styles":[],"fromTheFuture":1}"#).is_err());
    }
}
