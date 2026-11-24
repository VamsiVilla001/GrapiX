//! Product roles and their closed authority scopes.
//!
//! Authentication may identify a caller, but it must not leave each product to
//! invent what that identity may do. These types put the boundary in the shared
//! contract: an Editor authors only, Playout controls Program and outputs only,
//! and the engine reports only. That prevents an unknown spelling from quietly
//! becoming an empty or broader permission set at a product boundary.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The product identity carried by an authenticated connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    /// Authors mutable scene content and never controls Program or outputs.
    Editor,
    /// Cues, takes, clears Program and configures outputs.
    Playout,
    /// Reports engine state and never accepts product commands.
    Engine,
}

/// A closed authority a role may receive in a credential.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    /// Create and edit mutable authoring content.
    Author,
    /// Cue a published take.
    Cue,
    /// Take a published scene to Program.
    Take,
    /// Clear Program.
    Clear,
    /// Configure an output.
    ConfigureOutput,
    /// Ask the engine to stop in order (2.19). Held by no credential unless it
    /// is minted with it: stopping the engine ends Program, so nothing that can
    /// cue, take or clear gets it by being a Playout credential.
    Stop,
    /// Report engine status and events.
    Report,
}

impl Role {
    /// Whether this role is permitted to carry `scope`.
    ///
    /// A token may intentionally carry a subset of its role's authorities, but
    /// it may never cross the product boundary recorded by invariants 4 and 5.
    pub const fn permits(self, scope: Scope) -> bool {
        matches!(
            (self, scope),
            (Role::Editor, Scope::Author)
                | (
                    Role::Playout,
                    Scope::Cue | Scope::Take | Scope::Clear | Scope::ConfigureOutput | Scope::Stop
                )
                | (Role::Engine, Scope::Report)
        )
    }
}

/// Why a name is not accepted as an operator (2.15). The words are the wire values, and the
/// Playout page checks the same rules (`Playout/web/operator.js`); both are tested against
/// `Shared/contracts/fixtures/operator-names.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum OperatorNameFault {
    /// Nothing, or only spaces.
    Empty,
    /// More than [`OperatorName::MAX_CHARS`] characters.
    TooLong,
    /// A character other than a letter, a digit, a space or one of `. ' - _`.
    BadCharacter,
    /// The first character is not a letter or a digit.
    BadStart,
    /// Two spaces in a row.
    DoubleSpace,
}

impl std::fmt::Display for OperatorNameFault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Empty => "the name is empty",
            Self::TooLong => "the name is longer than 64 characters",
            Self::BadCharacter => "the name may hold letters, digits, spaces and . ' - _ only",
            Self::BadStart => "the name must start with a letter or a digit",
            Self::DoubleSpace => "the name has two spaces in a row",
        })
    }
}

/// The person operating Playout (2.15): who sent a Program command, as opposed to which
/// credential did. Trimmed, 1 to 64 characters, letters of any script, digits and
/// `space . ' - _`, starting with a letter or a digit, never two spaces in a row. A name
/// is an identity for the record, not a secret and not a grant: it adds no authority.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct OperatorName(String);

impl OperatorName {
    pub const MAX_CHARS: usize = 64;

    pub fn parse(input: &str) -> Result<Self, OperatorNameFault> {
        let name = input.trim();
        if name.is_empty() {
            return Err(OperatorNameFault::Empty);
        }
        if name.chars().count() > Self::MAX_CHARS {
            return Err(OperatorNameFault::TooLong);
        }
        if !name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '\'' | '-' | '_'))
        {
            return Err(OperatorNameFault::BadCharacter);
        }
        if !name.chars().next().is_some_and(char::is_alphanumeric) {
            return Err(OperatorNameFault::BadStart);
        }
        if name.contains("  ") {
            return Err(OperatorNameFault::DoubleSpace);
        }
        Ok(Self(name.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for OperatorName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2.15: the same cases the Playout page is tested against.
    #[test]
    fn operator_names_parse_as_the_shared_fixture_says() {
        let text = include_str!("../fixtures/operator-names.json");
        let fixture: serde_json::Value = serde_json::from_str(text).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 15);
        for case in cases {
            let input = case["input"].as_str().unwrap();
            match (case.get("name"), case.get("reason")) {
                (Some(name), None) => assert_eq!(
                    OperatorName::parse(input)
                        .as_ref()
                        .map(OperatorName::as_str),
                    Ok(name.as_str().unwrap()),
                    "{input:?}"
                ),
                (None, Some(reason)) => assert_eq!(
                    OperatorName::parse(input).map(|_| ()),
                    Err(serde_json::from_value::<OperatorNameFault>(reason.clone()).unwrap()),
                    "{input:?}"
                ),
                _ => panic!("a fixture case has a name or a reason, not both: {input:?}"),
            }
        }
    }

    #[test]
    fn a_fault_is_a_wire_word_and_says_what_is_wrong() {
        assert_eq!(
            serde_json::to_string(&OperatorNameFault::DoubleSpace).unwrap(),
            "\"doubleSpace\""
        );
        for fault in [
            OperatorNameFault::Empty,
            OperatorNameFault::TooLong,
            OperatorNameFault::BadCharacter,
            OperatorNameFault::BadStart,
            OperatorNameFault::DoubleSpace,
        ] {
            assert!(fault.to_string().starts_with("the name"));
        }
        assert_eq!(OperatorName::MAX_CHARS, 64);
    }

    #[test]
    fn roles_and_scopes_round_trip_on_the_wire() {
        let role = Role::Playout;
        let scope = Scope::ConfigureOutput;

        assert_eq!(
            serde_json::from_str::<Role>(&serde_json::to_string(&role).unwrap()).unwrap(),
            role
        );
        assert_eq!(
            serde_json::from_str::<Scope>(&serde_json::to_string(&scope).unwrap()).unwrap(),
            scope
        );
    }

    #[test]
    fn role_boundaries_match_the_product_ownership_rules() {
        assert!(Role::Editor.permits(Scope::Author));
        assert!(!Role::Editor.permits(Scope::Take));
        assert!(Role::Playout.permits(Scope::Cue));
        assert!(Role::Playout.permits(Scope::Take));
        assert!(Role::Playout.permits(Scope::Clear));
        assert!(Role::Playout.permits(Scope::ConfigureOutput));
        assert!(!Role::Playout.permits(Scope::Author));
        assert!(Role::Engine.permits(Scope::Report));
        assert!(!Role::Engine.permits(Scope::Clear));
    }

    /// 2.19: only a Playout credential may carry the stop scope; an Editor or
    /// an engine credential never can, whatever it is minted with.
    #[test]
    fn only_a_playout_credential_may_carry_the_stop_scope() {
        assert!(Role::Playout.permits(Scope::Stop));
        assert!(!Role::Editor.permits(Scope::Stop));
        assert!(!Role::Engine.permits(Scope::Stop));
        assert_eq!(serde_json::to_string(&Scope::Stop).unwrap(), "\"stop\"");
    }
}
