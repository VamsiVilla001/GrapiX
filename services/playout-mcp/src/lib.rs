//! The Program-side MCP tool bodies (build plan 8.7, 8.9, 8.10, 8.11).
//!
//! These are the tools ADR-0002 D.3 exists to gate. The rule it states is
//! blunt: *"A design-scope token must never reach `playout.take` or
//! `outputs.configure`. The automation pipeline runs as `author`. It publishes
//! drafts; a human takes them to air."*
//!
//! That gate is **not** in this file, and its absence here is deliberate. It
//! lives once, in `gx_mcp_server`, ahead of every handler. A handler that
//! re-checked would be a second gate waiting to disagree with the first, and
//! the disagreement would be discovered by something reaching air that should
//! not have (invariant 27). What this module contains is what happens *after*
//! a caller has been allowed through.
//!
//! **`render.preview` and invariant 3.** An agent seeing its own output is
//! ADR-0002 D.1's fifth principle and the differentiator over any design
//! tool's API. But the Editor may not import renderer internals, so the frame
//! arrives here as bytes the caller already rendered — the same seam the
//! import fidelity gate uses (7.3). This module compares and returns; it does
//! not rasterise, and could not.

#![forbid(unsafe_code)]

use gx_contracts::Refusal;
use gx_mcp_server::ToolHandler;
use serde::{Deserialize, Serialize};

fn parse<T: for<'de> Deserialize<'de>>(args: serde_json::Value) -> Result<T, Refusal> {
    serde_json::from_value(args).map_err(|error| Refusal::SceneParseFailed {
        detail: format!("arguments do not match the tool's input schema: {error}"),
    })
}

// --- render (8.9) ----------------------------------------------------------

/// One RGBA8 frame, as the caller rendered it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFrame {
    pub width: u32,
    pub height: u32,
    /// Row-major RGBA8. Carried as bytes rather than a path because the point
    /// is that the agent can *see* it without another round trip to a file it
    /// may not be able to read.
    pub pixels: Vec<u8>,
}

impl PreviewFrame {
    /// Refuse a frame whose byte count contradicts its dimensions.
    ///
    /// A short buffer would otherwise be read as a smaller image, and the
    /// agent would be looking at something real that is not what it asked for
    /// — worse than an error, because it looks like an answer.
    fn checked(self) -> Result<Self, Refusal> {
        let expected = self.width as usize * self.height as usize * 4;
        if self.pixels.len() == expected {
            Ok(self)
        } else {
            Err(Refusal::SceneParseFailed {
                detail: format!(
                    "frame declares {expected} RGBA8 bytes and carries {}",
                    self.pixels.len()
                ),
            })
        }
    }
}

/// `render.preview`: hand an agent the frame it just produced.
pub struct RenderPreview;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewArgs {
    frame: PreviewFrame,
}

impl ToolHandler for RenderPreview {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: PreviewArgs = parse(args)?;
        let frame = args.frame.checked()?;
        serde_json::to_value(frame).map_err(|error| Refusal::TransportFailed {
            detail: error.to_string(),
        })
    }
}

// --- packages (8.10) -------------------------------------------------------

/// What a publish produced.
///
/// The Take ID and revision together are the done-when: Playout takes an
/// *exact* revision, so a publish that reported only success would leave the
/// operator guessing which one to take.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub take_id: gx_contracts::TakeId,
    pub revision: gx_contracts::Revision,
    /// The design system the package was built against, so drift after a
    /// brand-pack update is listable rather than invisible (Part G, 7.6).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub design_system_version: Option<u32>,
}

/// `packages.publish`: turn a built package into a takeable revision.
pub struct PackagesPublish;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishArgs {
    package: std::path::PathBuf,
}

impl ToolHandler for PackagesPublish {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: PublishArgs = parse(args)?;
        // Reading the package verifies it: every manifest claim is checked
        // before anything is published, and a failure is a named refusal
        // rather than a partially registered revision (7.6).
        let verified = gx_asset_plane::package::read_package(&args.package).map_err(|error| {
            match error {
                gx_asset_plane::package::PackageError::Refused(refusal) => refusal,
                other => Refusal::TransportFailed {
                    detail: other.to_string(),
                },
            }
        })?;

        let result = PublishResult {
            take_id: gx_contracts::TakeId(verified.manifest.scene_id.clone()),
            revision: verified.manifest.scene_revision,
            design_system_version: verified.manifest.design_system_version,
        };
        serde_json::to_value(result).map_err(|error| Refusal::TransportFailed {
            detail: error.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::auth::Scope;
    use gx_contracts::mcp::ToolRegistry;

    #[test]
    fn an_author_token_is_refused_on_take_and_configure() {
        // 8.11's done-when. The gate is upstream of these handlers, so the
        // assertion belongs at the registry: proving the registry refuses is
        // proving the transport will, because the transport asks the registry.
        for forbidden in ["playout.take", "outputs.configure"] {
            assert!(
                matches!(
                    ToolRegistry::authorise(forbidden, &[Scope::Author]),
                    Err(Refusal::Unauthenticated)
                ),
                "{forbidden} must refuse an author token (ADR-0002 D.3)"
            );
        }
    }

    #[test]
    fn the_scopes_that_do_reach_program_are_the_operator_ones() {
        // The mirror of the rule above: the gate is not simply closed, it is
        // closed to the right callers and open to the right ones.
        assert!(ToolRegistry::authorise("playout.take", &[Scope::Take]).is_ok());
        assert!(
            ToolRegistry::authorise("outputs.configure", &[Scope::ConfigureOutput]).is_ok()
        );
    }

    #[test]
    fn designsystem_commit_is_admin_scoped() {
        // 8.7's done-when. An author works *inside* the system and cannot
        // change it (Part G), so the commit is not reachable with the scope
        // the automation pipeline runs as.
        assert!(matches!(
            ToolRegistry::authorise("designsystem.commit", &[Scope::Author]),
            Err(Refusal::Unauthenticated)
        ));
        assert!(ToolRegistry::authorise("designsystem.get", &[Scope::Author]).is_ok());
    }

    #[test]
    fn an_agent_gets_back_the_frame_it_rendered() {
        // 8.9's done-when: the agent can see its own output. Two pixels, so a
        // truncated buffer would be caught by the length check rather than
        // read as a smaller picture.
        let frame = serde_json::json!({
            "frame": { "width": 2, "height": 1, "pixels": [1, 2, 3, 255, 4, 5, 6, 255] }
        });
        let answer = RenderPreview.handle(frame).expect("a valid frame returns");
        let returned: PreviewFrame = serde_json::from_value(answer).unwrap();

        assert_eq!(returned.width, 2);
        assert_eq!(returned.pixels.len(), 8);
        assert_eq!(&returned.pixels[0..4], &[1, 2, 3, 255]);
    }

    #[test]
    fn a_frame_whose_bytes_contradict_its_dimensions_refuses() {
        // A short buffer read as a smaller image would look like an answer,
        // which is worse than an error.
        let short = serde_json::json!({
            "frame": { "width": 4, "height": 4, "pixels": [0, 0, 0, 255] }
        });
        assert!(matches!(
            RenderPreview.handle(short),
            Err(Refusal::SceneParseFailed { .. })
        ));
    }

    #[test]
    fn publishing_a_package_that_does_not_exist_refuses_rather_than_inventing_a_revision() {
        let missing = serde_json::json!({ "package": "no-such.gpxpkg" });
        assert!(PackagesPublish.handle(missing).is_err());
    }
}
