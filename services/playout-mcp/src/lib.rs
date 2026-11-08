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
//! **How `render.preview` gets a real frame.** An agent seeing its own output
//! is ADR-0002 D.1's fifth principle and the differentiator over any design
//! tool's API. It is also where the architecture is easiest to get wrong: the
//! tempting shortcut is to import the renderer and rasterise here, which
//! invariants 2 and 3 forbid. The tool asks the engine instead, over the
//! control plane, for the pinned revision at the requested frame. The engine
//! draws it through its one headless entry point (11.41) and serves the PNG on
//! the asset plane by content hash, where this module fetches it. No renderer
//! internals, no frame invented locally, and never "whatever Preview showed
//! last": the agent sees the frame it asked for (8.9).

#![forbid(unsafe_code)]

use gx_contracts::mcp::{ClearArgs, PackageBuild as BuildArgs, PackageRef, ProgramArgs};
use gx_contracts::Refusal;
use gx_control_plane::intent::{check_pin, TakeAt};
use gx_control_plane::message::OutputConfig;
use gx_control_plane::peer::EnginePeer;
use gx_mcp_server::ToolHandler;
use gx_playout::{OutputEnvironment, Playout, PublishedLibrary, PublishedScene};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

fn parse<T: serde::de::DeserializeOwned + Serialize>(
    args: serde_json::Value,
) -> Result<T, Refusal> {
    gx_contracts::command::parse_strict(args).map_err(|error| Refusal::SceneParseFailed {
        detail: format!("arguments do not match the tool's input schema: {error}"),
    })
}

fn transport_failed(error: impl std::fmt::Display) -> Refusal {
    Refusal::TransportFailed {
        detail: error.to_string(),
    }
}

// --- render (8.9) ----------------------------------------------------------

/// Where `render.preview` fetches the PNG the engine drew.
///
/// A trait so the tool can be driven in a test without an asset-plane socket.
/// The engine serves headless images by content hash (11.41); this is the
/// fetch, nothing more.
pub trait ImageSource: Send + Sync {
    fn fetch(&self, hash: &gx_contracts::ContentHash) -> Result<Vec<u8>, Refusal>;
}

/// The engine's asset plane, where headless renders are served by hash.
pub struct AssetPlaneImages(pub std::net::SocketAddr);

impl ImageSource for AssetPlaneImages {
    fn fetch(&self, hash: &gx_contracts::ContentHash) -> Result<Vec<u8>, Refusal> {
        gx_asset_plane::publish::fetch_bytes(self.0, hash).map_err(transport_failed)
    }
}

/// `render.preview`: the frame of a pinned revision an agent asked for, drawn
/// by the engine.
///
/// The answer is an MCP image content block holding the PNG, plus the
/// structured `PreviewFrame` (revision, frame, size and the image's content
/// hash). The PNG is checked against that hash before it is handed over, so a
/// corrupted or substituted image is refused by name rather than shown.
pub struct RenderPreview<P: EnginePeer, I: ImageSource> {
    pub tools: std::sync::Arc<ProgramTools<P>>,
    pub images: I,
}

impl<P: EnginePeer, I: ImageSource> ToolHandler for RenderPreview<P, I> {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: gx_contracts::mcp::PreviewRequest = parse(args)?;
        let reply = self.tools.playout.lock().peer_mut().handle(
            gx_control_plane::message::ClientRequest::Render(
                gx_control_plane::render::RenderRequest {
                    take_id: args.take_id,
                    revision: args.revision,
                    content_hash: args.content_hash,
                    frame: args.frame,
                },
            ),
        );
        let rendered = match reply {
            gx_control_plane::message::EngineReply::Rendered(rendered) => rendered,
            // The engine's refusal is the answer: unknown take, unpinned or
            // mismatched revision, a frame past the timeline, a revision with
            // no scene to draw.
            gx_control_plane::message::EngineReply::Refused(refusal) => return Err(refusal),
            other => {
                return Err(Refusal::TransportFailed {
                    detail: format!("render.preview expected a rendered frame, got {other:?}"),
                })
            }
        };
        let png = self.images.fetch(&rendered.image)?;
        let actual = gx_asset_plane::content_hash(&png);
        if actual != rendered.image {
            return Err(Refusal::AssetHashMismatch {
                expected: rendered.image,
                actual,
            });
        }
        let frame = gx_contracts::mcp::PreviewFrame {
            take_id: rendered.take_id,
            revision: rendered.revision,
            content_hash: rendered.content_hash,
            frame: rendered.frame,
            width: rendered.width,
            height: rendered.height,
            image: rendered.image,
            image_bytes: png.len() as u64,
        };
        Ok(serde_json::json!({
            "content": [{ "type": "image", "data": base64(&png), "mimeType": "image/png" }],
            "structuredContent": serde_json::to_value(frame).map_err(transport_failed)?,
        }))
    }

    /// The value above is already the MCP `CallToolResult`: the wire must
    /// carry the image block as it is, not wrap the whole thing as text.
    fn returns_call_tool_result(&self) -> bool {
        true
    }
}

/// Standard base64 with padding (RFC 4648 §4), which MCP image content uses.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> shift) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
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

fn package_refusal(error: gx_asset_plane::package::PackageError) -> Refusal {
    match error {
        gx_asset_plane::package::PackageError::Refused(refusal) => refusal,
        other => transport_failed(other),
    }
}

/// `packages.build`: build and verify a package, all-or-nothing.
pub struct PackagesBuild;

impl ToolHandler for PackagesBuild {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: BuildArgs = parse(args)?;
        let sources: Vec<_> = args
            .sources
            .into_iter()
            .map(|source| gx_asset_plane::package::PackageSource {
                path: source.path,
                source: source.source,
            })
            .collect();

        // The writer verifies the candidate before it replaces anything, so a
        // build that fails leaves the previous package byte-identical (7.6).
        let manifest = gx_asset_plane::package::write_package(
            &args.output,
            &args.scene,
            &sources,
            args.design_system_version,
        )
        .map_err(package_refusal)?;

        serde_json::to_value(manifest).map_err(transport_failed)
    }
}

/// `packages.inspect`: read a package's manifest without publishing it.
///
/// Reading verifies, so inspect is not a cheaper path that skips checks — it
/// is the same verification without the publication. A caller that could look
/// inside an unverified package would be reading claims rather than facts.
pub struct PackagesInspect;

impl ToolHandler for PackagesInspect {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: PackageRef = parse(args)?;
        let verified =
            gx_asset_plane::package::read_package(&args.package).map_err(package_refusal)?;
        serde_json::to_value(verified.manifest).map_err(transport_failed)
    }
}

/// `packages.publish`: turn a verified package into a takeable revision.
pub struct PackagesPublish(pub Mutex<PublishedLibrary>);

impl ToolHandler for PackagesPublish {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: PackageRef = parse(args)?;
        let verified =
            gx_asset_plane::package::read_package(&args.package).map_err(package_refusal)?;

        // Publishing is additive: the same scene id published again yields a
        // new revision rather than editing the one already issued (invariant
        // 30), which is why the library assigns it rather than the manifest.
        let scene = serde_json::to_value(&verified.scene).map_err(transport_failed)?;
        // The stamp is stored with the revision, not merely echoed back. It
        // is what makes "which templates predate v4" a query over the library
        // rather than an investigation (7.6, 10.5); reading it and dropping it
        // left the drift report with nothing real to read.
        let published = self.0.lock().publish(
            verified.manifest.scene_id.clone(),
            scene,
            verified.manifest.design_system_version,
        );

        let result = PublishResult {
            take_id: published.take_id,
            revision: published.revision,
            design_system_version: published.design_system_version,
        };
        serde_json::to_value(result).map_err(transport_failed)
    }
}

// --- playout and outputs (8.11) --------------------------------------------

/// The Program-control handlers, over a live engine peer.
///
/// Generic over the peer for the same reason `gx_playout::Playout` is: the
/// production caller supplies a control-transport client and a test supplies a
/// stub, without either being a special case of the other.
pub struct ProgramTools<P: EnginePeer> {
    pub playout: Mutex<Playout<P>>,
    pub library: Mutex<PublishedLibrary>,
    pub environment: OutputEnvironment,
}

/// What a listing or review answers with for one revision.
fn published_revision(scene: &PublishedScene) -> gx_contracts::PublishedRevision {
    gx_contracts::PublishedRevision {
        take_id: scene.take_id.clone(),
        revision: scene.revision,
        content_hash: scene.content_hash.clone(),
        review: scene.review,
    }
}

fn scheduled(frame: Option<u64>) -> TakeAt {
    match frame {
        Some(frame) => TakeAt::Frame { frame },
        None => TakeAt::NextOpportunity,
    }
}

impl<P: EnginePeer> ProgramTools<P> {
    fn pinned(&self, args: &ProgramArgs) -> Result<PublishedScene, Refusal> {
        // The exact revision, never the latest: a take against a stale
        // revision must refuse rather than quietly air a newer one
        // (invariant 17, and 6.3). And only by the hash the caller pinned
        // (invariant 61): the content it approved is the content that airs.
        let take_id = gx_contracts::TakeId(args.take_id.clone());
        let revision = gx_contracts::Revision(args.revision);
        let scene = self
            .library
            .lock()
            .revision(&take_id, revision)
            .cloned()
            .ok_or_else(|| Refusal::UnknownTake {
                take_id: take_id.clone(),
            })?;
        let held = scene
            .content_hash
            .clone()
            .ok_or_else(|| Refusal::RevisionUnpinned {
                take_id: take_id.clone(),
                revision,
            })?;
        check_pin(&take_id, revision, &held, args.content_hash.as_ref())?;
        Ok(scene)
    }
}

/// `playout.take`: put a published revision on Program.
pub struct PlayoutTake<P: EnginePeer>(pub std::sync::Arc<ProgramTools<P>>);

impl<P: EnginePeer> ToolHandler for PlayoutTake<P> {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: ProgramArgs = parse(args)?;
        let scene = self.0.pinned(&args)?;
        let committed = self.0.playout.lock().take(&scene, scheduled(args.frame))?;
        // The engine's committed frame, never the requested one: intent-based
        // control is only honest if the caller sees what the engine chose.
        serde_json::to_value(committed).map_err(transport_failed)
    }
}

/// `playout.cue`: prepare a revision without airing it.
pub struct PlayoutCue<P: EnginePeer>(pub std::sync::Arc<ProgramTools<P>>);

impl<P: EnginePeer> ToolHandler for PlayoutCue<P> {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: ProgramArgs = parse(args)?;
        let scene = self.0.pinned(&args)?;
        let committed = self.0.playout.lock().cue(&scene, scheduled(args.frame))?;
        serde_json::to_value(committed).map_err(transport_failed)
    }
}

/// `playout.library`: the published takes and the revisions they hold.
///
/// Read-only and author-scoped: knowing what *could* go to air is design
/// information, and only the taking of it is an operator act (ADR-0002 D.3).
pub struct PlayoutLibrary<P: EnginePeer>(pub std::sync::Arc<ProgramTools<P>>);

impl<P: EnginePeer> ToolHandler for PlayoutLibrary<P> {
    fn handle(&self, _args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let library = self.0.library.lock();
        let takes: Vec<_> = library
            .takes()
            .into_iter()
            .map(|(take_id, revisions)| {
                // Each revision with the hash a take must pin and its review
                // state, so the pin an operator copies is the content listed.
                let revisions: Vec<_> = revisions
                    .into_iter()
                    .filter_map(|revision| library.revision(&take_id, revision))
                    .map(published_revision)
                    .collect();
                serde_json::json!({
                    "takeId": take_id,
                    "revisions": revisions,
                })
            })
            .collect();
        Ok(serde_json::json!({ "takes": takes }))
    }
}

/// `playout.review`: move a published revision through review.
///
/// Operator-scoped (`Take`), the scope a human operator holds and an agent
/// credential never does (invariant 65): agents publish drafts, and only a
/// human proposes or approves them (11.38). The content stays immutable.
pub struct PlayoutReview<P: EnginePeer>(pub std::sync::Arc<ProgramTools<P>>);

impl<P: EnginePeer> ToolHandler for PlayoutReview<P> {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: gx_contracts::ReviewRequest = parse(args)?;
        let mut library = self.0.library.lock();
        let scene = library.set_review(&args.take_id, args.revision, args.review)?;
        serde_json::to_value(published_revision(scene)).map_err(transport_failed)
    }
}

/// `outputs.list`: the adapters, what each became, and the reference state.
///
/// Reported from the engine's own capability rather than from what was last
/// requested. The two can disagree — an output asked to go live and refused
/// is exactly the case an operator needs to see — and only the engine's
/// answer is a fact (invariants 20 and 27).
pub struct OutputsList<P: EnginePeer>(pub std::sync::Arc<ProgramTools<P>>);

impl<P: EnginePeer> ToolHandler for OutputsList<P> {
    fn handle(&self, _args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let capability = self.0.playout.lock().peer().capability();
        Ok(serde_json::json!({
            "deviceTier": capability.device_tier,
            "reference": capability.reference,
            "clock": capability.clock,
            "liveAllowed": capability.live_allowed,
            "platformCertified": self.0.environment.platform_certified,
            "media": capability.media,
            "material": capability.material,
        }))
    }
}

/// `playout.clear`: return Program to black.
pub struct PlayoutClear<P: EnginePeer>(pub std::sync::Arc<ProgramTools<P>>);

impl<P: EnginePeer> ToolHandler for PlayoutClear<P> {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: ClearArgs = parse(args)?;
        let committed = self.0.playout.lock().clear(scheduled(args.frame))?;
        serde_json::to_value(committed).map_err(transport_failed)
    }
}

/// `outputs.configure`: configure an output, with `is_live` gated.
pub struct OutputsConfigure<P: EnginePeer>(pub std::sync::Arc<ProgramTools<P>>);

impl<P: EnginePeer> ToolHandler for OutputsConfigure<P> {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let config: OutputConfig = parse(args)?;
        let adapter = config.adapter.clone();
        // `live` in the answer is the *engine's* decision, not the caller's
        // request. Liveness is gated on tier, platform and reference inside
        // `live_allowed`, and echoing the request back would let a refused
        // live output read as a configured one (invariant 20).
        let live = self
            .0
            .playout
            .lock()
            .configure_output(config, self.0.environment.clone())?;
        Ok(serde_json::json!({ "adapter": adapter, "live": live }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::auth::Scope;
    use gx_contracts::mcp::ToolRegistry;
    use gx_control_plane::capability::EngineCapability;
    use gx_control_plane::intent::TakeCommitted;
    use gx_control_plane::message::{ClientRequest, EngineEvent, EngineReply};

    // --- scope gating (8.11, 8.7) -------------------------------------------

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
        assert!(ToolRegistry::authorise("playout.take", &[Scope::Take]).is_ok());
        assert!(ToolRegistry::authorise("outputs.configure", &[Scope::ConfigureOutput]).is_ok());
    }

    #[test]
    fn designsystem_commit_is_admin_scoped() {
        // 8.7's done-when. An author works *inside* the system and cannot
        // change it (Part G).
        assert!(matches!(
            ToolRegistry::authorise("designsystem.commit", &[Scope::Author]),
            Err(Refusal::Unauthenticated)
        ));
        assert!(ToolRegistry::authorise("designsystem.get", &[Scope::Author]).is_ok());
    }

    // --- render.preview (8.9) -----------------------------------------------

    /// A one-pixel PNG standing in for what the engine served.
    const PNG: &[u8] = b"\x89PNG fixture";

    struct FixedImages(Vec<u8>);

    impl ImageSource for FixedImages {
        fn fetch(&self, _hash: &gx_contracts::ContentHash) -> Result<Vec<u8>, Refusal> {
            Ok(self.0.clone())
        }
    }

    fn preview_args(published: &PublishedScene, frame: u64) -> serde_json::Value {
        serde_json::json!({
            "takeId": published.take_id.0,
            "revision": published.revision.0,
            "contentHash": published.content_hash,
            "frame": frame,
        })
    }

    #[test]
    fn render_preview_answers_with_the_requested_frame_as_an_image_block() {
        let (tools, published) = program_tools();
        let answer = RenderPreview {
            tools,
            images: FixedImages(PNG.to_vec()),
        }
        .handle(preview_args(&published, 7))
        .expect("a rendered frame is returned");
        assert_eq!(answer["content"][0]["type"], "image");
        assert_eq!(answer["content"][0]["mimeType"], "image/png");
        assert_eq!(answer["content"][0]["data"], base64(PNG));
        let frame: gx_contracts::mcp::PreviewFrame =
            serde_json::from_value(answer["structuredContent"].clone()).unwrap();
        assert_eq!(
            frame.frame, 7,
            "the frame asked for, not whatever Preview showed"
        );
        assert_eq!(frame.image, gx_asset_plane::content_hash(PNG));
        assert_eq!(frame.image_bytes, PNG.len() as u64);
    }

    #[test]
    fn render_preview_passes_the_engines_refusal_through_by_name() {
        let (tools, published) = program_tools();
        let tool = RenderPreview {
            tools,
            images: FixedImages(PNG.to_vec()),
        };
        assert!(matches!(
            tool.handle(preview_args(&published, 11)),
            Err(Refusal::RenderFrameOutOfRange { frame: 11, .. })
        ));
        assert!(
            matches!(
                tool.handle(
                    serde_json::json!({ "takeId": "x", "revision": 1, "frame": 0, "atFrame": 3 })
                ),
                Err(Refusal::SceneParseFailed { .. })
            ),
            "an unknown argument is refused, never ignored"
        );
    }

    #[test]
    fn render_preview_refuses_an_image_that_does_not_match_its_hash() {
        let (tools, published) = program_tools();
        let tool = RenderPreview {
            tools,
            images: FixedImages(b"substituted".to_vec()),
        };
        assert!(matches!(
            tool.handle(preview_args(&published, 0)),
            Err(Refusal::AssetHashMismatch { .. })
        ));
    }

    #[test]
    fn base64_matches_rfc_4648_test_vectors() {
        for (input, expected) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(input.as_bytes()), expected);
        }
    }

    // --- packages (8.10) ----------------------------------------------------

    fn scratch(label: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("gx-playout-mcp-{label}-{nanos}"));
        std::fs::create_dir_all(&path).expect("scratch directory");
        path
    }

    fn scene(id: &str) -> gx_contracts::scene::SceneDocument {
        gx_contracts::scene::SceneDocument {
            working_color_space: gx_contracts::color::WorkingColorSpace::LinearSrgb,
            id: id.into(),
            name: id.into(),
            version: gx_contracts::scene::SCENE_SCHEMA_VERSION,
            revision: Some(gx_contracts::Revision(1)),
            active_camera_id: None,
            canvas: gx_contracts::scene::SceneCanvas {
                width: 1920,
                height: 1080,
                frame_rate: gx_contracts::RationalRate::P50,
            },
            timeline: gx_contracts::scene::SceneTimeline {
                duration_frames: 1,
                ..Default::default()
            },
            data_context: Default::default(),
            assets: Vec::new(),
            fonts: Vec::new(),
            materials: Vec::new(),
            controls: Vec::new(),
            text_styles: Vec::new(),
            objects: Vec::new(),
        }
    }

    #[test]
    fn build_then_inspect_then_publish_returns_a_take_id_and_revision() {
        // 8.10's done-when. Build produces a verified package, inspect reads
        // it back without publishing, and publish names the exact revision an
        // operator must take.
        let root = scratch("packages");
        let package = root.join("lower-third.gpxpkg");

        let manifest = PackagesBuild
            .handle(serde_json::json!({
                "output": package,
                "scene": serde_json::to_value(scene("lower-third")).unwrap(),
                "designSystemVersion": 3,
            }))
            .expect("the package builds and verifies");
        assert_eq!(manifest["designSystemVersion"], 3);

        let inspected = PackagesInspect
            .handle(serde_json::json!({ "package": package }))
            .expect("inspect verifies without publishing");
        assert_eq!(inspected["sceneId"], "lower-third");

        let publisher = PackagesPublish(Mutex::new(PublishedLibrary::default()));
        let first: PublishResult = serde_json::from_value(
            publisher
                .handle(serde_json::json!({ "package": package }))
                .expect("the package publishes"),
        )
        .unwrap();
        assert_eq!(first.take_id.0, "lower-third");
        assert_eq!(first.revision, gx_contracts::Revision(1));
        assert_eq!(first.design_system_version, Some(3));

        // Publishing is additive: the same identity yields a new revision
        // rather than editing the one already issued (invariant 30).
        let second: PublishResult = serde_json::from_value(
            publisher
                .handle(serde_json::json!({ "package": package }))
                .expect("republishing is additive"),
        )
        .unwrap();
        assert_eq!(second.take_id, first.take_id);
        assert_eq!(second.revision, gx_contracts::Revision(2));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inspecting_a_package_that_does_not_exist_refuses() {
        assert!(PackagesInspect
            .handle(serde_json::json!({ "package": "no-such.gpxpkg" }))
            .is_err());
    }

    // --- playout handlers (8.11) --------------------------------------------

    /// An engine that commits everything at a fixed frame.
    struct TestPeer {
        committed: u64,
    }

    impl EnginePeer for TestPeer {
        fn capability(&self) -> EngineCapability {
            EngineCapability {
                protocol: gx_contracts::PROTOCOL_VERSION,
                epoch: gx_contracts::Epoch(1),
                locality: gx_contracts::Locality::CoLocated,
                device_tier: gx_contracts::DeviceTier::T0,
                clock: gx_contracts::ClockSource::FreeRun,
                reference: gx_contracts::ReferenceState::NotPresent,
                live_allowed: false,
                media: Vec::new(),
                material: gx_contracts::material::MaterialSupport::none(),
            }
        }

        fn handle(&mut self, request: ClientRequest) -> EngineReply {
            let committed = TakeCommitted {
                frame: self.committed,
                timebase: gx_contracts::RationalRate::P50,
                clock: gx_contracts::ClockSource::FreeRun,
            };
            match request {
                ClientRequest::Cue(_) => EngineReply::Cued(committed),
                ClientRequest::Take(_) => EngineReply::Taken(committed),
                ClientRequest::Clear(_) => EngineReply::Cleared(committed),
                ClientRequest::ConfigureOutput(config) => EngineReply::OutputConfigured {
                    adapter: config.adapter,
                    live: config.live,
                },
                ClientRequest::Render(request) if request.frame > 10 => {
                    EngineReply::Refused(Refusal::RenderFrameOutOfRange {
                        take_id: request.take_id,
                        revision: request.revision,
                        frame: request.frame,
                        duration_frames: 10,
                    })
                }
                ClientRequest::Render(request) => {
                    EngineReply::Rendered(gx_control_plane::render::RenderedFrame {
                        take_id: request.take_id,
                        revision: request.revision,
                        content_hash: request
                            .content_hash
                            .unwrap_or_else(|| gx_contracts::ContentHash("a".repeat(64))),
                        frame: request.frame,
                        width: 1,
                        height: 1,
                        image: gx_asset_plane::content_hash(PNG),
                        image_bytes: PNG.len() as u64,
                    })
                }
                other => EngineReply::Refused(Refusal::NotImplemented {
                    what: format!("{other:?}"),
                }),
            }
        }

        fn drain_events(&mut self) -> Vec<EngineEvent> {
            Vec::new()
        }
    }

    fn program_tools() -> (std::sync::Arc<ProgramTools<TestPeer>>, PublishedScene) {
        let mut library = PublishedLibrary::default();
        let published = library.publish("lower-third", serde_json::Value::Null, None);
        (
            std::sync::Arc::new(ProgramTools {
                playout: Mutex::new(Playout::new(TestPeer { committed: 120 })),
                library: Mutex::new(library),
                environment: OutputEnvironment {
                    platform_certified: true,
                },
            }),
            published,
        )
    }

    #[test]
    fn a_take_reports_the_frame_the_engine_committed_to() {
        // Intent-based control is only honest if the caller sees the engine's
        // choice rather than its own request (ADR-002, invariant 9).
        let (tools, published) = program_tools();
        let answer = PlayoutTake(tools)
            .handle(serde_json::json!({
                "takeId": published.take_id.0,
                "revision": published.revision.0,
                "contentHash": published.content_hash,
            }))
            .expect("a published revision takes");
        assert_eq!(answer["frame"], 120);
    }

    #[test]
    fn a_take_loads_only_by_its_pinned_hash() {
        // Invariant 61 on the automation surface: no pin, or a pin naming
        // other content, is refused by name before anything is sent.
        let (tools, published) = program_tools();
        let take = PlayoutTake(std::sync::Arc::clone(&tools));
        let unpinned = take
            .handle(serde_json::json!({ "takeId": published.take_id.0, "revision": 1 }))
            .expect_err("an unpinned take refuses");
        assert!(matches!(unpinned, Refusal::RevisionUnpinned { .. }));
        let other = take
            .handle(serde_json::json!({ "takeId": published.take_id.0, "revision": 1, "contentHash": "f".repeat(64) }))
            .expect_err("a take of other content refuses");
        assert!(
            matches!(&other, Refusal::RevisionHashMismatch { expected, .. } if Some(expected) == published.content_hash.as_ref())
        );
    }

    #[test]
    fn only_an_operator_scope_moves_a_revision_through_review() {
        // An agent publishes drafts; a human approves them (invariant 65).
        assert!(matches!(
            ToolRegistry::authorise("playout.review", &[Scope::Author]),
            Err(Refusal::Unauthenticated)
        ));
        assert!(ToolRegistry::authorise("playout.review", &[Scope::Take]).is_ok());

        let (tools, published) = program_tools();
        let answer = PlayoutReview(std::sync::Arc::clone(&tools))
            .handle(serde_json::json!({ "takeId": published.take_id.0, "revision": 1, "review": "approved" }))
            .expect("an operator approves");
        assert_eq!(answer["review"], "approved");
        assert_eq!(
            answer["contentHash"],
            serde_json::json!(published.content_hash)
        );
    }

    #[test]
    fn a_cue_also_reports_the_engines_frame() {
        let (tools, published) = program_tools();
        let answer = PlayoutCue(tools)
            .handle(serde_json::json!({
                "takeId": published.take_id.0,
                "revision": published.revision.0,
                "contentHash": published.content_hash,
            }))
            .expect("a published revision cues");
        assert_eq!(answer["frame"], 120);
    }

    #[test]
    fn a_take_against_an_unpublished_revision_refuses_by_name() {
        // 6.3's rule reaching the automation surface: a stale revision cannot
        // go to air, and the refusal says which problem it is.
        let (tools, published) = program_tools();
        let refusal = PlayoutTake(tools)
            .handle(serde_json::json!({
                "takeId": published.take_id.0,
                "revision": 99,
                "contentHash": published.content_hash,
            }))
            .expect_err("an unpublished revision must refuse");
        assert!(matches!(refusal, Refusal::UnknownTake { .. }));
    }

    #[test]
    fn no_program_command_can_express_a_wall_clock_time() {
        // Invariants 8 and 9 made structural: the only scheduling the argument
        // type can carry is a frame number, and its absence means the next
        // opportunity. There is no `now` to send.
        let rejected: Result<ProgramArgs, _> = serde_json::from_value(serde_json::json!({
            "takeId": "x",
            "revision": 1,
            "frame": "2026-09-12T10:00:00Z",
        }));
        assert!(rejected.is_err(), "a timestamp is not a frame number");

        let args: ProgramArgs =
            serde_json::from_value(serde_json::json!({ "takeId": "x", "revision": 1 })).unwrap();
        assert!(matches!(scheduled(args.frame), TakeAt::NextOpportunity));
    }

    #[test]
    fn a_clear_returns_the_engines_committed_frame() {
        let (tools, _) = program_tools();
        let answer = PlayoutClear(tools)
            .handle(serde_json::json!({}))
            .expect("clear commits");
        assert_eq!(answer["frame"], 120);
    }

    #[test]
    fn the_library_lists_every_revision_not_only_the_newest() {
        // An operator pins an exact revision, so a listing that showed only
        // the latest would make a valid pin look unavailable.
        let (tools, published) = program_tools();
        tools
            .library
            .lock()
            .publish("lower-third", serde_json::Value::Null, None);

        let answer = PlayoutLibrary(tools)
            .handle(serde_json::Value::Null)
            .expect("the library lists");
        let takes = answer["takes"].as_array().unwrap();
        assert_eq!(takes.len(), 1);
        assert_eq!(takes[0]["takeId"], published.take_id.0);
        let revisions: Vec<_> = takes[0]["revisions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["revision"].clone())
            .collect();
        assert_eq!(revisions, [serde_json::json!(1), serde_json::json!(2)]);
        assert_eq!(
            takes[0]["revisions"][0]["contentHash"],
            serde_json::json!(published.content_hash)
        );
        assert_eq!(takes[0]["revisions"][0]["review"], "draft");
    }

    #[test]
    fn outputs_list_reports_the_engines_liveness_not_the_environments() {
        // The platform is certified here and the engine still says live is
        // not allowed. A listing that merged the two would hide which one is
        // blocking (invariant 20).
        let (tools, _) = program_tools();
        let answer = OutputsList(tools)
            .handle(serde_json::Value::Null)
            .expect("outputs list");
        assert_eq!(answer["platformCertified"], true);
        assert_eq!(answer["liveAllowed"], false);
        assert_eq!(answer["deviceTier"], "T0");
        assert_eq!(
            answer["material"],
            serde_json::json!(gx_contracts::material::MaterialSupport::none())
        );
    }

    #[test]
    fn a_non_live_output_configures_and_reports_what_it_became() {
        let (tools, _) = program_tools();
        let answer = OutputsConfigure(tools)
            .handle(serde_json::json!({
                "adapter": "recording",
                "live": false,
                "acceptFreeRun": false,
            }))
            .expect("a non-live output configures");
        assert_eq!(answer["adapter"], "recording");
        assert_eq!(answer["live"], false);
    }

    #[test]
    fn a_live_output_below_t0_refuses_naming_the_actual_tier() {
        // Invariant 19: a live adapter refuses unless the tier, platform and
        // reference all permit it, and the refusal names which condition
        // failed so an operator can act on it.
        let mut library = PublishedLibrary::default();
        library.publish("s", serde_json::Value::Null, None);
        struct SubT0(TestPeer);
        impl EnginePeer for SubT0 {
            fn capability(&self) -> EngineCapability {
                EngineCapability {
                    device_tier: gx_contracts::DeviceTier::T2,
                    ..self.0.capability()
                }
            }
            fn handle(&mut self, request: ClientRequest) -> EngineReply {
                self.0.handle(request)
            }
            fn drain_events(&mut self) -> Vec<EngineEvent> {
                Vec::new()
            }
        }

        let tools = std::sync::Arc::new(ProgramTools {
            playout: Mutex::new(Playout::new(SubT0(TestPeer { committed: 1 }))),
            library: Mutex::new(library),
            environment: OutputEnvironment {
                platform_certified: true,
            },
        });

        let refusal = OutputsConfigure(tools)
            .handle(serde_json::json!({
                "adapter": "decklink",
                "live": true,
                "acceptFreeRun": true,
            }))
            .expect_err("a sub-T0 device cannot go live");
        assert!(
            matches!(refusal, Refusal::TierTooLow { actual } if actual == gx_contracts::DeviceTier::T2),
            "the refusal must name the actual tier, got {refusal:?}"
        );
    }
}
