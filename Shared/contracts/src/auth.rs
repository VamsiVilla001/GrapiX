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
                    Scope::Cue | Scope::Take | Scope::Clear | Scope::ConfigureOutput
                )
                | (Role::Engine, Scope::Report)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
