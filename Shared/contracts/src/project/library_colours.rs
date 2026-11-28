//! Project-local Library colours (plan row 11.122, the Colours tab). A library colour is a named solid colour kept in the project:
//! an id, a name that is unique in the project (ignoring case) and a colour with the space its numbers are in. Applying one to a
//! graphic copies the colour into the object, so nothing links a graphic to the library: editing or deleting a library colour never
//! changes a graphic (asked of Jev and Laya first, `docs/evidence/11.122/jev-laya-colours.json`).
//!
//! Gradients, layer styles and backgrounds are later library items.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::color::Rgba;

/// Most colours one project's library holds.
pub const MOST_COLOURS: usize = 500;
/// Longest name, in characters.
pub const LONGEST_NAME: usize = 64;

/// One named colour in the project's library.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryColour {
    pub id: String,
    pub name: String,
    pub color: Rgba,
}

/// The project's library colours, in the order they were made.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryColours {
    #[serde(default)]
    pub colours: Vec<LibraryColour>,
    #[serde(default)]
    next_colour_sequence: u64,
}

/// A colour the engine can paint with: finite components and an alpha from 0 to 1 (what `setPaint` already requires of a solid colour).
pub fn check_colour(colour: &Rgba) -> Result<(), String> {
    let finite = [colour.r, colour.g, colour.b, colour.a].iter().all(|value| value.is_finite());
    if !finite || !(0.0..=1.0).contains(&colour.a) {
        return Err("a colour needs finite components and an alpha from 0 to 1".to_owned());
    }
    Ok(())
}

impl LibraryColours {
    /// No colour was ever made: nothing to write.
    pub fn is_untouched(&self) -> bool {
        self.colours.is_empty() && self.next_colour_sequence == 0
    }

    pub fn create_named(&mut self, name: &str, colour: Rgba) -> Result<String, String> {
        if self.colours.len() >= MOST_COLOURS {
            return Err(format!("a project's library holds at most {MOST_COLOURS} colours"));
        }
        let name = self.check_name(None, name)?.to_owned();
        check_colour(&colour)?;
        let mut sequence = self.next_colour_sequence;
        loop {
            sequence = sequence.checked_add(1).ok_or("Library colour IDs exhausted")?;
            let id = format!("colour-{sequence}");
            if self.colours.iter().any(|existing| existing.id == id) {
                continue;
            }
            self.next_colour_sequence = sequence;
            self.colours.push(LibraryColour { id: id.clone(), name, color: colour });
            return Ok(id);
        }
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Result<(), String> {
        let index = self.index(id)?;
        let name = self.check_name(Some(id), name)?.to_owned();
        self.colours[index].name = name;
        Ok(())
    }

    pub fn set_colour(&mut self, id: &str, colour: Rgba) -> Result<(), String> {
        let index = self.index(id)?;
        check_colour(&colour)?;
        self.colours[index].color = colour;
        Ok(())
    }

    /// Remove the swatch. Graphics keep the colours they were given: nothing links them to it.
    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        let index = self.index(id)?;
        self.colours.remove(index);
        Ok(())
    }

    pub(crate) fn check(&self) -> Result<(), String> {
        if self.colours.len() > MOST_COLOURS {
            return Err(format!("a project's library holds at most {MOST_COLOURS} colours"));
        }
        for (position, colour) in self.colours.iter().enumerate() {
            if colour.id.trim().is_empty() || self.colours[..position].iter().any(|earlier| earlier.id == colour.id) {
                return Err(format!("invalid or duplicate Library colour ID {:?}", colour.id));
            }
            self.check_name(Some(&colour.id), &colour.name)?;
            check_colour(&colour.color).map_err(|why| format!("Library colour {:?}: {why}", colour.name))?;
        }
        Ok(())
    }

    fn index(&self, id: &str) -> Result<usize, String> {
        self.colours.iter().position(|colour| colour.id == id).ok_or_else(|| format!("unknown Library colour {id:?}"))
    }

    /// A name of 1 to 64 characters with no control character, unique in the project ignoring case (the colour `except` may keep its own).
    fn check_name<'a>(&self, except: Option<&str>, name: &'a str) -> Result<&'a str, String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > LONGEST_NAME || name.chars().any(char::is_control) {
            return Err(format!("a Library colour's name is 1 to {LONGEST_NAME} characters with no control character, not {name:?}"));
        }
        let folded = name.to_lowercase();
        if self.colours.iter().any(|colour| Some(colour.id.as_str()) != except && colour.name.to_lowercase() == folded) {
            return Err(format!("a Library colour named {name:?} already exists"));
        }
        Ok(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::SourceColorSpace;

    fn red() -> Rgba {
        Rgba::new(1.0, 0.0, 0.0, 1.0, SourceColorSpace::Srgb)
    }

    #[test]
    fn colours_are_made_in_order_with_their_own_ids_and_names_trimmed() {
        let mut library = LibraryColours::default();
        assert_eq!(library.create_named("  Team red ", red()).unwrap(), "colour-1");
        assert_eq!(library.create_named("Ink", Rgba::new(0.1, 0.1, 0.1, 1.0, SourceColorSpace::Srgb)).unwrap(), "colour-2");
        assert_eq!(library.colours.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Team red", "Ink"]);
        library.check().unwrap();
    }

    #[test]
    fn an_id_is_not_reused_after_a_delete() {
        let mut library = LibraryColours::default();
        library.create_named("A", red()).unwrap();
        library.create_named("B", red()).unwrap();
        library.delete("colour-2").unwrap();
        assert_eq!(library.create_named("C", red()).unwrap(), "colour-3");
    }

    #[test]
    fn a_name_is_unique_ignoring_case_and_refused_by_name() {
        let mut library = LibraryColours::default();
        library.create_named("Team red", red()).unwrap();
        assert!(library.create_named("TEAM RED", red()).unwrap_err().contains("already exists"));
        library.create_named("Ink", red()).unwrap();
        assert!(library.rename("colour-2", "team red").unwrap_err().contains("already exists"));
        // A colour may keep its own name, in other letters.
        library.rename("colour-1", "TEAM RED").unwrap();
        assert_eq!(library.colours[0].name, "TEAM RED");
    }

    #[test]
    fn a_name_is_one_to_sixty_four_characters_without_control_characters() {
        let mut library = LibraryColours::default();
        for bad in ["", "   ", "tab\there", "line\nbreak"] {
            assert!(library.create_named(bad, red()).unwrap_err().contains("1 to 64 characters"), "{bad:?}");
        }
        assert!(library.create_named(&"x".repeat(65), red()).is_err());
        assert!(library.create_named(&"x".repeat(64), red()).is_ok());
        // Characters, not bytes.
        assert!(library.create_named(&"\u{00e9}".repeat(64), red()).is_ok());
    }

    #[test]
    fn a_colour_needs_finite_components_and_an_alpha_from_zero_to_one() {
        let mut library = LibraryColours::default();
        for bad in [
            Rgba::new(f64::NAN, 0.0, 0.0, 1.0, SourceColorSpace::Srgb),
            Rgba::new(0.0, f64::INFINITY, 0.0, 1.0, SourceColorSpace::Srgb),
            Rgba::new(0.0, 0.0, 0.0, 1.5, SourceColorSpace::Srgb),
            Rgba::new(0.0, 0.0, 0.0, -0.1, SourceColorSpace::Srgb),
        ] {
            assert!(library.create_named("Bad", bad).unwrap_err().contains("finite components"));
        }
        // A component above 1 is a legal wide-gamut or scene-referred value, and alpha at its ends is fine.
        library.create_named("Bright", Rgba::new(4.0, 0.0, 0.0, 0.0, SourceColorSpace::Srgb)).unwrap();
        library.create_named("Solid", Rgba::new(0.0, 0.0, 0.0, 1.0, SourceColorSpace::Srgb)).unwrap();
    }

    #[test]
    fn a_colour_keeps_the_space_it_was_made_in() {
        let mut library = LibraryColours::default();
        let id = library.create_named("P3 red", Rgba::new(1.0, 0.0, 0.0, 1.0, SourceColorSpace::DisplayP3)).unwrap();
        assert_eq!(library.colours[0].color.space, SourceColorSpace::DisplayP3);
        library.set_colour(&id, red()).unwrap();
        assert_eq!(library.colours[0].color.space, SourceColorSpace::Srgb);
        assert!(library.set_colour(&id, Rgba::new(0.0, 0.0, 0.0, 2.0, SourceColorSpace::Srgb)).is_err());
        assert_eq!(library.colours[0].color, red(), "a refused change leaves the colour as it was");
    }

    #[test]
    fn an_unknown_colour_is_refused_by_name() {
        let mut library = LibraryColours::default();
        for result in [library.rename("colour-9", "X"), library.set_colour("colour-9", red()), library.delete("colour-9")] {
            assert_eq!(result.unwrap_err(), "unknown Library colour \"colour-9\"");
        }
    }

    #[test]
    fn a_library_holds_at_most_five_hundred_colours() {
        let mut library = LibraryColours::default();
        for number in 0..MOST_COLOURS {
            library.create_named(&format!("c{number}"), red()).unwrap();
        }
        assert!(library.create_named("one more", red()).unwrap_err().contains("at most 500"));
        library.delete("colour-1").unwrap();
        library.create_named("one more", red()).unwrap();
    }

    #[test]
    fn a_stored_library_is_checked_when_the_project_is_opened() {
        let mut library = LibraryColours::default();
        library.create_named("A", red()).unwrap();
        library.create_named("B", red()).unwrap();
        library.check().unwrap();
        let mut duplicate_id = library.clone();
        duplicate_id.colours[1].id = "colour-1".into();
        assert!(duplicate_id.check().unwrap_err().contains("duplicate Library colour ID"));
        let mut duplicate_name = library.clone();
        duplicate_name.colours[1].name = "a".into();
        assert!(duplicate_name.check().unwrap_err().contains("already exists"));
        let mut bad_colour = library;
        bad_colour.colours[0].color.a = f64::NAN;
        assert!(bad_colour.check().unwrap_err().contains("Library colour \"A\""));
    }

    #[test]
    fn a_library_nobody_used_is_not_written_but_one_that_was_is_kept_empty() {
        let mut library = LibraryColours::default();
        assert!(library.is_untouched());
        library.create_named("A", red()).unwrap();
        assert!(!library.is_untouched());
        library.delete("colour-1").unwrap();
        // Emptied, it still remembers how far its ids went, so an id is not handed out twice.
        assert!(!library.is_untouched());
        assert_eq!(library.create_named("B", red()).unwrap(), "colour-2");
    }

    #[test]
    fn it_round_trips_through_json_and_an_older_project_reads_without_it() {
        let mut library = LibraryColours::default();
        library.create_named("Team red", red()).unwrap();
        let json = serde_json::to_string(&library).unwrap();
        assert_eq!(serde_json::from_str::<LibraryColours>(&json).unwrap(), library);
        assert_eq!(serde_json::from_str::<LibraryColours>("{}").unwrap(), LibraryColours::default());
        assert!(serde_json::from_str::<LibraryColours>(r#"{"colours":[],"fromTheFuture":1}"#).is_err());
    }
}
