//! The Editor's Tauri 2 shell (build plan 11.1, 11.36).
//!
//! **This file is where invariants 4 and 5 are enforced.** The Editor owns
//! mutable authoring content and cannot change Program or outputs. That is
//! not a runtime check on a message here — it is the absence of a command:
//! the surface below has no `cue`, no `take`, no `clear` and no
//! `configure_output`, so a compromised or mistaken web layer cannot reach
//! one however it asks. A flag on a shared command would be a check that can
//! be forgotten; an absent command cannot be.
//!
//! **Every authoring mutation is one command (11.36, invariant 60).**
//! `cmd_execute` parses an `EditorCommand` and hands it to the Rust
//! `Workspace`, which owns the open documents, their histories and every
//! store write. The browser holds no document it can send back: it renders
//! the `SessionView` it is given, and nothing on this surface accepts a whole
//! scene from it.
//!
//! What else it exposes is read-only: catalogues, the rule surfaces the
//! panels are built from, and publication. Font ingest is the one exception
//! that writes, and it writes only the per-user content-addressed asset
//! cache, never authoring content. It returns a prepared batch, and the batch
//! reaches a scene only as one `addFonts` edit through `cmd_execute`.
//! Publication is the whole of the
//! Editor's authority over Program — it produces a revision Playout may later
//! take, and nothing more (invariant 7: a mutable Editor scene never replaces
//! a published one in place).
//!
//! The shell never imports renderer internals (invariant 3). It speaks the
//! asset plane's published contract and holds no GPU state.

// EditorError carries the structured refusal or command error it reports to
// the Editor UI; the large-Err lint would have it boxed for no gain.
#![allow(clippy::result_large_err)]
#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use gx_asset_plane::fonts::ingest::{
    prepare_font_files, FontFileInput, FontIngestRefusal, PreparedFontBatch, SceneFontLibrary,
};
use gx_asset_plane::fonts::link::{prepare_font_link, UreqFontFetcher};
use gx_asset_plane::fonts::manager::LinkedSource;
use gx_asset_plane::import::{prepare_asset_files, AssetFileInput, PreparedAssetBatch};
use gx_asset_plane::package::{PackageSource, MAX_PACKAGE_BYTES};
use gx_asset_plane::{content_hash, AssetHandoff, AssetStore, AssetStoreError, PublishRefusal};
use gx_contracts::animation::{animation_surface, validate_scene_animation, AnimationSurface};
use gx_contracts::command::{
    parse_command, CommandOutcome, EditorCommand, OpenScene, SaveScene, SaveTarget, SceneSource,
    SceneTarget, SessionKey, SessionView,
};
use gx_contracts::control::{
    apply_control_values, fillable_properties, ControlFieldKind, ControlValue, TakePage,
};
use gx_contracts::design_system::{starter_presets, MotionPreset};
use gx_contracts::font::EmbeddingPolicy;
use gx_contracts::platform::service_data_root;
use gx_contracts::scene::{AssetLibraryItem, SceneDocument};
use gx_contracts::{ContentHash, Refusal, Revision, TakeId};
use gx_editor::publish::{package_sources, publish_document, PublishFailure};
use gx_editor::{CommandError, Projects, Workspace};
use serde::{Deserialize, Serialize};

/// The asset-plane endpoint an Editor publishes to by default.
///
/// The control port plus one, matching the worker's own default. Exposed to
/// the web layer as a starting value, never as a silent fallback: a failed
/// connection is reported with the address it tried.
pub const DEFAULT_ASSET_ENDPOINT: &str = gx_contracts::endpoints::DEFAULT_ASSET_ENDPOINT;

/// The shell's one piece of state: the workspace every command runs against.
///
/// A poisoned lock is recovered rather than propagated. That is safe because
/// the workspace only ever commits a fully prepared document by a final swap,
/// so a panic mid-command cannot leave a half-applied edit behind it.
pub struct ShellState {
    workspace: Mutex<Workspace>,
    /// The per-user content-addressed asset cache, opened on first use. A
    /// machine without a cache directory can still edit; font ingest then
    /// refuses by name instead of the shell failing to start.
    assets: Mutex<Option<AssetStore>>,
    /// The folder every publication writes its package into (5.10):
    /// `GX_EDITOR_PACKAGE_DIR` if set, else the platform's package exchange
    /// root. Resolved once. A machine with neither can still edit; publishing
    /// then refuses by name before any socket opens.
    package_directory: Result<PathBuf, Refusal>,
    /// The edits that applied to each target since it was last published (2.17).
    edits: Mutex<EditLedger>,
}

/// The ids of the edits that applied to each scene target since it was last
/// published (2.17), so a publish can name the edits it carries.
///
/// An edit's id is the one the front end gave the shell call that made it
/// (2.13). It is kept per target, newest [`gx_telemetry::corr::MAX_CARRIED`]
/// only, with a count of the older ones, and for at most [`MAX_LEDGER_TARGETS`]
/// targets: a person can make hundreds of edits between publishes, and the
/// ledger must not grow with them.
#[derive(Default)]
struct EditLedger {
    targets: BTreeMap<String, Pending>,
    /// The number the next recorded edit gets. Edits are numbered across all
    /// targets in the order they applied, so "everything up to here" can be
    /// said exactly however many were let go in between.
    next: u64,
}

/// The edits of one target not yet published, as the ledger holds them.
#[derive(Debug, Default)]
struct Pending {
    /// Oldest first, each with its number.
    ids: Vec<(u64, String)>,
    /// Older edits whose ids were let go to stay within the limit.
    dropped: u64,
    /// The number of the newest edit let go.
    dropped_last: u64,
}

/// What a publish of one target carries: the edits not yet published when it
/// was taken.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct TargetEdits {
    /// Oldest first.
    ids: Vec<String>,
    /// Older edits it holds whose ids were let go.
    dropped: u64,
    /// Every edit numbered below this was applied before the publish was taken,
    /// so a publish that succeeds has carried exactly those.
    upto: u64,
}

/// The most targets the ledger follows at once. A target beyond them is not
/// followed until another is published: its edits are applied, and a publish of
/// it names none (named limit).
const MAX_LEDGER_TARGETS: usize = 256;

impl EditLedger {
    /// An edit with this id applied to `target`. One shell call is one id, so a
    /// call that makes several edits is entered once.
    fn record(&mut self, target: &str, id: &str) {
        if !self.targets.contains_key(target) && self.targets.len() >= MAX_LEDGER_TARGETS {
            return;
        }
        let edits = self.targets.entry(target.to_owned()).or_default();
        if edits.ids.last().map(|(_, last)| last.as_str()) == Some(id) {
            return;
        }
        edits.ids.push((self.next, id.to_owned()));
        self.next += 1;
        if edits.ids.len() > gx_telemetry::corr::MAX_CARRIED {
            let (number, _) = edits.ids.remove(0);
            edits.dropped += 1;
            edits.dropped_last = number;
        }
    }

    /// What a publish of `target` carries now.
    fn snapshot(&self, target: &str) -> TargetEdits {
        let pending = self.targets.get(target);
        TargetEdits {
            ids: pending
                .map(|edits| edits.ids.iter().map(|(_, id)| id.clone()).collect())
                .unwrap_or_default(),
            dropped: pending.map_or(0, |edits| edits.dropped),
            upto: self.next,
        }
    }

    /// `carried` was published: forget exactly the edits applied before it was
    /// taken, by their numbers. An edit made while the publish was in flight
    /// stays for the next one, even when it pushed an older id out of the list
    /// (matching by position would then forget the new edit and keep a count
    /// for an old one that was published; found on review).
    fn forget(&mut self, target: &str, carried: &TargetEdits) {
        let Some(edits) = self.targets.get_mut(target) else {
            return;
        };
        edits.ids.retain(|(number, _)| *number >= carried.upto);
        // Ids let go before the publish was taken were published with it. If
        // any was let go after (more than the limit of edits during one
        // publish), the count is kept whole: it can then say more than are
        // left, never fewer.
        if edits.dropped > 0 && edits.dropped_last < carried.upto {
            edits.dropped = 0;
        }
        if edits.ids.is_empty() && edits.dropped == 0 {
            self.targets.remove(target);
        }
    }
}

/// The text a log names a scene target by (`session:3`, `project/scene`).
fn target_text(target: &gx_contracts::command::SceneTarget) -> String {
    match target {
        gx_contracts::command::SceneTarget::Session { session } => {
            format!("session:{}", session.0)
        }
        gx_contracts::command::SceneTarget::Stored { project, scene_id } => {
            format!("{project}/{scene_id}")
        }
    }
}

/// The environment variable that names the Editor's package folder.
pub const PACKAGE_DIR_ENV: &str = "GX_EDITOR_PACKAGE_DIR";

/// Where this Editor writes packages: the folder a co-located engine is
/// started with as `--package-dir`, and a LAN publisher's outbox.
pub fn resolve_package_directory() -> Result<PathBuf, Refusal> {
    match std::env::var_os(PACKAGE_DIR_ENV) {
        Some(set) if !set.is_empty() => {
            std::path::absolute(&set).map_err(|error| Refusal::PlatformDirectoryUnavailable {
                detail: format!("{PACKAGE_DIR_ENV} cannot be made absolute: {error}"),
            })
        }
        _ => gx_contracts::platform::package_exchange_root(),
    }
}

impl ShellState {
    /// Use this folder as the asset cache instead of the per-user one (a test, or
    /// a deployment that keeps it elsewhere).
    #[must_use]
    pub fn with_asset_root(self, root: PathBuf) -> Self {
        *self
            .assets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(AssetStore::at_root(root));
        self
    }

    /// Write packages into this folder instead of the resolved one.
    #[must_use]
    pub fn with_package_directory(mut self, directory: PathBuf) -> Self {
        self.package_directory = Ok(directory);
        self
    }

    pub fn new(workspace: Workspace) -> Self {
        Self {
            workspace: Mutex::new(workspace),
            assets: Mutex::new(None),
            package_directory: resolve_package_directory(),
            edits: Mutex::new(EditLedger::default()),
        }
    }

    fn edits(&self) -> MutexGuard<'_, EditLedger> {
        self.edits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Run one command as `cmd_execute` does, and note the id of the call that
    /// made an edit that applied, against the target it edited (2.17). A
    /// refused command, and a command that is not an edit, notes nothing.
    pub fn execute_command(&self, command: EditorCommand) -> Result<CommandOutcome, EditorError> {
        let edited = match &command {
            EditorCommand::EditScene(edit) => Some(target_text(&edit.target)),
            _ => None,
        };
        // The edit is noted while the workspace is still held, so a publish that
        // reads the document under the same lock sees the edit and its note
        // together or neither (lock order: workspace, then the ledger).
        let mut workspace = self.workspace();
        let outcome = execute(&mut workspace, command)?;
        if let (Some(target), Some(id)) = (edited, gx_telemetry::corr::current()) {
            self.edits().record(&target, &id);
        }
        Ok(outcome)
    }

    /// The document a target names and the edits that applied to it and are not
    /// yet published, read together under the workspace lock: every edit the
    /// document holds is named, and none it does not hold (an edit lands in the
    /// workspace and in the ledger under that one lock).
    fn document_and_edits(
        &self,
        target: &SceneTarget,
    ) -> Result<(SceneDocument, TargetEdits), EditorError> {
        let workspace = self.workspace();
        let scene = workspace
            .document(target)
            .map_err(|error| command_error(error, None))?
            .into_owned();
        let edits = self.edits().snapshot(&target_text(target));
        Ok((scene, edits))
    }

    /// Publish the document a target names, naming the edits that applied to it
    /// since it was last published (2.17): they are on the shell's own record, in
    /// the asset-plane header the engine reads, and on the engine's
    /// `publish.accepted`. The ids are forgotten only once the publish succeeds,
    /// and only those it carried: a failed publish keeps them for the next try.
    pub fn publish_target(
        &self,
        endpoint: &str,
        target: SceneTarget,
    ) -> Result<PublishResult, EditorError> {
        let key = target_text(&target);
        let (scene, carried) = self.document_and_edits(&target)?;
        // The cache files are checked under the store lock; the package is
        // written and published after it is released.
        let sources = self.with_asset_store(|store| {
            package_sources(&scene, store).map_err(|failure| publish_error(failure, None))
        })?;
        let directory = self.package_directory()?;
        let _carry = (!carried.ids.is_empty() || carried.dropped > 0)
            .then(|| gx_telemetry::corr::carry(&carried.ids, carried.dropped));
        let result = publish_with_sources(endpoint, &directory, scene, &sources);
        if result.is_ok() {
            self.edits().forget(&key, &carried);
        }
        result
    }

    fn package_directory(&self) -> Result<PathBuf, EditorError> {
        self.package_directory.clone().map_err(refused)
    }

    fn workspace(&self) -> MutexGuard<'_, Workspace> {
        self.workspace
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn with_asset_store<T>(
        &self,
        run: impl FnOnce(&mut AssetStore) -> Result<T, EditorError>,
    ) -> Result<T, EditorError> {
        let mut store = self
            .assets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if store.is_none() {
            *store = Some(AssetStore::new().map_err(|error| EditorError::AssetCache {
                detail: error.to_string(),
            })?);
        }
        run(store.as_mut().expect("the asset store was opened above"))
    }
}

/// Everything the Editor shell can fail at, named.
///
/// One enum for the whole surface, because the web layer shows the same
/// message box for all of them and a stringly-typed error would let a
/// refusal be presented as a crash.
#[derive(Debug, Serialize)]
#[serde(tag = "error", rename_all = "camelCase")]
pub enum EditorError {
    /// A scene file could not be read.
    ReadScene { path: String, detail: String },
    /// A scene file could not be written.
    WriteScene { path: String, detail: String },
    /// The endpoint text is not a socket address.
    InvalidEndpoint { endpoint: String },
    /// The asset plane could not be reached at all. Distinct from a refusal:
    /// nothing was decided, so nothing was published.
    Unreachable { endpoint: String, detail: String },
    /// The engine understood the document and declined it, by name.
    PublishRefused { detail: String },
    /// A reply arrived that is not a reply.
    Protocol { detail: String },
    /// The project store could not complete an operation. The machine
    /// failed; nothing about the request was decided.
    ProjectFailed { detail: String },
    /// A named refusal from the shared contract vocabulary — a command the
    /// workspace declined, a read the store declined, a take-page value of
    /// the wrong type. `cause` is the refusal itself, so the web layer can
    /// act on it rather than parse prose.
    CommandRefused { detail: String, cause: Refusal },
    /// A file the author picked could not be read.
    ReadFile { path: String, detail: String },
    /// The per-user asset cache could not be opened or read.
    AssetCache { detail: String },
    /// The package for a publication could not be written into the Editor's
    /// package folder (5.10).
    WritePackage { path: String, detail: String },
}

impl std::fmt::Display for EditorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ReadScene { path, detail } => write!(f, "cannot read {path}: {detail}"),
            Self::WriteScene { path, detail } => write!(f, "cannot write {path}: {detail}"),
            Self::InvalidEndpoint { endpoint } => {
                write!(f, "{endpoint} is not a host:port address")
            }
            Self::Unreachable { endpoint, detail } => {
                write!(f, "cannot reach the asset plane at {endpoint}: {detail}")
            }
            Self::PublishRefused { detail } => write!(f, "publication refused: {detail}"),
            Self::Protocol { detail } => write!(f, "asset plane protocol failed: {detail}"),
            Self::ProjectFailed { detail } => write!(f, "project operation failed: {detail}"),
            Self::CommandRefused { detail, .. } => write!(f, "refused: {detail}"),
            Self::ReadFile { path, detail } => write!(f, "cannot read {path}: {detail}"),
            Self::AssetCache { detail } => write!(f, "asset cache unavailable: {detail}"),
            Self::WritePackage { path, detail } => {
                write!(f, "cannot write the package {path}: {detail}")
            }
        }
    }
}

impl std::error::Error for EditorError {}

fn refused(cause: Refusal) -> EditorError {
    EditorError::CommandRefused {
        detail: cause.to_string(),
        cause,
    }
}

/// An Editor-side read of its own per-user asset cache that failed. A missing
/// or altered entry keeps its refusal's name. Anything else is the cache's
/// fault, not the engine's, so it is the cache error and never
/// `AssetStoreFailed`, which names the engine's own store (the 5.11 review).
fn cache_read_failed(error: AssetStoreError, hash: &ContentHash) -> EditorError {
    match error.into_refusal(hash) {
        Refusal::AssetStoreFailed { detail, .. } => EditorError::AssetCache {
            detail: format!("{hash}: {detail}"),
        },
        other => refused(other),
    }
}

/// A refused ingest keeps its refusal's name and says which input it was.
fn ingest_refused(refusal: FontIngestRefusal) -> EditorError {
    EditorError::CommandRefused {
        detail: format!("{}: {}", refusal.source, refusal.refusal),
        cause: refusal.refusal,
    }
}

/// Carry a project-store failure onto the shell surface: a store refusal
/// keeps its name, a machine failure keeps its detail.
fn project_error(error: gx_editor::project::EditorError) -> EditorError {
    match error {
        gx_editor::project::EditorError::Refused(cause) => refused(cause),
        error => EditorError::ProjectFailed {
            detail: error.to_string(),
        },
    }
}

/// Which scene file, if any, a command reads or writes. A filesystem failure
/// then reaches the author as "cannot read/write <path>", not as a project
/// failure that names no file.
#[derive(Clone, Copy)]
enum SceneFile {
    Read,
    Write,
}

fn scene_file(command: &EditorCommand) -> Option<SceneFile> {
    match command {
        EditorCommand::OpenScene(OpenScene {
            source: SceneSource::File { .. },
        }) => Some(SceneFile::Read),
        EditorCommand::SaveScene(SaveScene {
            to: SaveTarget::File { .. },
            ..
        }) => Some(SceneFile::Write),
        _ => None,
    }
}

fn command_error(error: CommandError, file: Option<SceneFile>) -> EditorError {
    use gx_editor::project::EditorError as Store;
    match (error, file) {
        (CommandError::Refused(cause), _) => refused(cause),
        (CommandError::Store(Store::Io { path, source }), Some(SceneFile::Read)) => {
            EditorError::ReadScene {
                path: path.display().to_string(),
                detail: source.to_string(),
            }
        }
        (CommandError::Store(Store::Io { path, source }), Some(SceneFile::Write)) => {
            EditorError::WriteScene {
                path: path.display().to_string(),
                detail: source.to_string(),
            }
        }
        (CommandError::Store(error), _) => project_error(error),
    }
}

/// Run one parsed command against the workspace.
pub fn execute(
    workspace: &mut Workspace,
    command: EditorCommand,
) -> Result<CommandOutcome, EditorError> {
    // 2.12: every command and what came of it is on record: its name, the
    // scene it addressed, the revision it named and the one it produced, its
    // effects, or the refusal. Not the edits themselves: the scene keeps them.
    let name = command.name();
    let (target, if_revision, edits) = match &command {
        EditorCommand::EditScene(edit) => (
            Some(target_text(&edit.target)),
            edit.if_revision.map(|r| r.0),
            Some(edit.edits.len()),
        ),
        _ => (None, None, None),
    };
    let file = scene_file(&command);
    let result = workspace
        .execute(command)
        .map_err(|error| command_error(error, file));
    match &result {
        Ok(outcome) => {
            let effects: Vec<String> = outcome
                .effects
                .iter()
                .map(|effect| {
                    serde_json::to_value(effect)
                        .ok()
                        .and_then(|v| v.get("effect").and_then(|e| e.as_str()).map(str::to_owned))
                        .unwrap_or_else(|| "unknown".to_owned())
                })
                .collect();
            tracing::info!(
                event = "editor.command",
                command = name,
                result = "applied",
                target = target.as_deref(),
                if_revision,
                revision = outcome.revision.map(|r| r.0),
                edits,
                effects = ?effects,
            );
        }
        Err(error) => tracing::info!(
            event = "editor.command",
            command = name,
            result = "refused",
            refusal = match error {
                EditorError::CommandRefused { cause, .. } => Some(cause.code_name()),
                _ => None,
            },
            detail = %error,
            target = target.as_deref(),
            if_revision,
            edits,
        ),
    }
    result
}

/// What a successful publication produced.
///
/// The revision is the point: Playout takes an exact revision, so the Editor
/// must report the one it created rather than "published successfully".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub take_id: TakeId,
    pub revision: Revision,
    /// The content hash every cue and take of this revision must pin.
    pub content_hash: ContentHash,
    /// The route the engine's own declaration negotiated: `localPath` or
    /// `chunkedUpload`. Reported so the author sees how it was published.
    pub handoff: AssetHandoff,
    /// Asset bytes this Editor sent: none by path, the missing difference
    /// over a LAN.
    pub transferred_bytes: u64,
}

/// An Editor-side failure to publish, as the web layer sees it (5.10).
///
/// `directory` is this Editor's package folder when it is known, so a refusal
/// that is about the folder (an engine started without `--package-dir`, or
/// with a different one) says where this Editor writes.
fn publish_error(failure: PublishFailure, directory: Option<&Path>) -> EditorError {
    match failure {
        PublishFailure::InvalidEndpoint { endpoint } => EditorError::InvalidEndpoint { endpoint },
        PublishFailure::Unreachable { endpoint, detail } => {
            EditorError::Unreachable { endpoint, detail }
        }
        PublishFailure::NotSent(refusal) => refused(refusal),
        PublishFailure::AssetCache { detail } => EditorError::AssetCache { detail },
        PublishFailure::TransferRefused(cause) => EditorError::PublishRefused {
            detail: cause.to_string(),
        },
        PublishFailure::EngineRefused(refusal) => {
            let (detail, about_the_folder) = match refusal {
                PublishRefusal::InvalidPublishRequest { detail } => (detail, false),
                PublishRefusal::SceneRefused { cause }
                | PublishRefusal::PreparationRefused { cause } => (cause.to_string(), false),
                PublishRefusal::PackageRefused { cause } => (
                    cause.to_string(),
                    matches!(
                        cause,
                        Refusal::PackageDirectoryNotConfigured { .. }
                            | Refusal::PackagePathOutsideDirectory { .. }
                    ),
                ),
            };
            EditorError::PublishRefused {
                detail: match (about_the_folder, directory) {
                    (true, Some(directory)) => format!(
                        "{detail}; this Editor writes its packages into {}, which a co-located engine must be started with as --package-dir",
                        directory.display()
                    ),
                    _ => detail,
                },
            }
        }
        PublishFailure::WritePackage { path, detail } => EditorError::WritePackage { path, detail },
        PublishFailure::Protocol { detail } => EditorError::Protocol { detail },
    }
}

/// Publish a document with its package sources into `directory` and report the
/// revision it became (5.10): `gx_editor::publish::publish_document` with the
/// shell's error mapping. The one command path, shared by `cmd_publish` and
/// the shell's tests (invariant 60).
///
/// Publication is atomic at the far end: the engine either produces a new
/// immutable revision or refuses the whole document (invariant 30). The two
/// outcomes stay distinct to the web layer: an unreachable engine is not a
/// refusal, and a refusal is not a crash.
pub fn publish_with_sources(
    endpoint: &str,
    directory: &Path,
    scene: SceneDocument,
    sources: &[PackageSource],
) -> Result<PublishResult, EditorError> {
    let scene_id = scene.id.clone();
    let result = publish_document(endpoint, scene, sources, directory)
        .map(|published| PublishResult {
            take_id: published.take_id,
            revision: published.revision,
            content_hash: published.content_hash,
            handoff: published.handoff,
            transferred_bytes: published.transferred_bytes,
        })
        .map_err(|failure| publish_error(failure, Some(directory)));
    // 2.12: a publication and what came of it. 2.17: and the edits it carried,
    // when the caller named any (a carry scope is entered around this call).
    let carries = gx_telemetry::corr::carried_text();
    let carries = carries.as_deref();
    let carries_dropped = Some(gx_telemetry::corr::carried_dropped()).filter(|n| *n > 0);
    match &result {
        Ok(published) => tracing::info!(
            event = "editor.publish",
            result = "published",
            carries,
            carries_dropped,
            scene = scene_id.as_str(),
            endpoint,
            take_id = published.take_id.0.as_str(),
            revision = published.revision.0,
            content_hash = published.content_hash.0.as_str(),
            handoff = ?published.handoff,
            transferred_bytes = published.transferred_bytes,
        ),
        Err(error) => tracing::info!(
            event = "editor.publish",
            result = "failed",
            detail = %error,
            carries,
            carries_dropped,
            scene = scene_id.as_str(),
            endpoint,
        ),
    }
    result
}

/// Preview operator values through Rust's one control-value application.
///
/// The returned document is a filled copy; the template the target names is
/// untouched, so operator data can never be persisted into the reusable
/// scene.
pub fn take_page_preview(
    workspace: &Workspace,
    target: &SceneTarget,
    values: &BTreeMap<String, ControlValue>,
) -> Result<SceneDocument, EditorError> {
    let template = workspace
        .document(target)
        .map_err(|error| command_error(error, None))?;
    apply_control_values(&template, values).map_err(refused)
}

/// The per-user projects root. A shell that cannot name one says so rather
/// than writing into whatever directory it was launched from.
fn projects() -> Result<Projects, EditorError> {
    let root = service_data_root().map_err(refused)?;
    Ok(Projects::at_root(root.join("projects")))
}

/// A scene as the manager lists it. Ids come from the store; the rest is what
/// the panel needs to say something true about each one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedScene {
    pub scene_id: String,
    pub name: String,
    /// Set when the scene carries a revision, meaning it has been published.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_revision: Option<u64>,
    /// Why this row cannot be opened, when its file exists but will not parse.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

/// One container's graphics. Catalog reads have no design-system dependency.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSceneCatalog {
    pub project: String,
    pub scenes: Vec<ListedScene>,
}

/// A take page as the project manager lists it.
///
/// The template id is carried visibly so an operator cannot reopen values
/// against a different scene by accident.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedTakePage {
    pub page_id: String,
    pub name: String,
    pub scene_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

/// The saved take-page instances for one project.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTakePageCatalog {
    pub project: String,
    pub pages: Vec<ListedTakePage>,
}

/// The scenes in a project, each read through the closed reader.
///
/// A scene that will not parse is reported by name rather than dropped from
/// the list: an author whose file has gone bad needs to see it, not to find
/// it silently missing.
pub fn scene_catalog(store: &Projects, project: &str) -> Result<ProjectSceneCatalog, EditorError> {
    let ids = store.list_scenes(project).map_err(project_error)?;
    let mut scenes = Vec::with_capacity(ids.len());
    for scene_id in ids {
        match store.read_scene(project, &scene_id) {
            Ok(scene) => scenes.push(ListedScene {
                scene_id,
                name: scene.name,
                published_revision: scene.revision.map(|revision| revision.0),
                unavailable_reason: None,
            }),
            Err(error) => scenes.push(ListedScene {
                name: scene_id.clone(),
                scene_id,
                published_revision: None,
                unavailable_reason: Some(format!("scene file is unreadable: {error}")),
            }),
        }
    }
    Ok(ProjectSceneCatalog {
        project: project.to_owned(),
        scenes,
    })
}

/// One stored scene, refused by name if publish would refuse its animation —
/// the same check `OpenScene` runs, so a read cannot preview a curve the
/// engine would reject.
pub fn scene_read(
    store: &Projects,
    project: &str,
    scene_id: &str,
) -> Result<SceneDocument, EditorError> {
    let scene = store.read_scene(project, scene_id).map_err(project_error)?;
    validate_scene_animation(&scene).map_err(refused)?;
    Ok(scene)
}

/// The saved template instances in a project, unreadable ones named.
pub fn take_page_catalog(
    store: &Projects,
    project: &str,
) -> Result<ProjectTakePageCatalog, EditorError> {
    let ids = store.list_take_pages(project).map_err(project_error)?;
    let mut pages = Vec::with_capacity(ids.len());
    for page_id in ids {
        match store.read_take_page(project, &page_id) {
            Ok(page) => pages.push(ListedTakePage {
                page_id,
                name: page.name,
                scene_id: page.scene_id,
                unavailable_reason: None,
            }),
            Err(error) => pages.push(ListedTakePage {
                name: page_id.clone(),
                scene_id: String::new(),
                page_id,
                unavailable_reason: Some(format!("take-page file is unreadable: {error}")),
            }),
        }
    }
    Ok(ProjectTakePageCatalog {
        project: project.to_owned(),
        pages,
    })
}

// ---------------------------------------------------------------------------
// The Tauri command surface.
//
// Every command the Editor has. Read the list: one mutator, the rest reads
// and publication, and no way to reach Program from here. That is the design.
// ---------------------------------------------------------------------------

/// The one authoring mutator. Strictly parsed: an unknown field anywhere in
/// the command refuses by its dotted path rather than being ignored.
#[tauri::command]
fn cmd_execute(
    state: tauri::State<'_, ShellState>,
    command: serde_json::Value,
) -> Result<CommandOutcome, EditorError> {
    let command = parse_command(command).map_err(refused)?;
    state.execute_command(command)
}

/// Import an SVG file as a new unbound graphic (7.2, 11.17). The source bytes
/// go into the asset cache under their hash first, so the graphic's source
/// asset resolves when it is saved into a project; then the session opens
/// with the report as an `Imported` effect.
#[tauri::command]
fn cmd_import_file(
    state: tauri::State<'_, ShellState>,
    path: String,
    id: String,
) -> Result<CommandOutcome, EditorError> {
    let bytes = std::fs::read(&path).map_err(|error| EditorError::ReadFile {
        path: path.clone(),
        detail: error.to_string(),
    })?;
    let svg = String::from_utf8(bytes).map_err(|_| {
        refused(Refusal::SceneParseFailed {
            detail: format!("{path} is not UTF-8 text, so it is not an SVG document"),
        })
    })?;
    let source_name = std::path::Path::new(&path)
        .file_name()
        .map_or_else(|| path.clone(), |name| name.to_string_lossy().into_owned());
    state.with_asset_store(|store| {
        store
            .promote_verified(&content_hash(svg.as_bytes()), svg.as_bytes())
            .map_err(|error| EditorError::AssetCache {
                detail: error.to_string(),
            })
    })?;
    execute(
        &mut state.workspace(),
        EditorCommand::OpenScene(OpenScene {
            source: SceneSource::ImportSvg {
                id,
                source_name,
                svg,
            },
        }),
    )
}

#[tauri::command]
fn cmd_session_view(
    state: tauri::State<'_, ShellState>,
    session: SessionKey,
) -> Result<SessionView, EditorError> {
    state
        .workspace()
        .view(session)
        .map_err(|error| command_error(error, None))
}

/// Publish the document a target names. The document is cloned under the
/// lock and published after it is released: no network IO under the mutex.
#[tauri::command]
fn cmd_publish(
    state: tauri::State<'_, ShellState>,
    endpoint: String,
    target: SceneTarget,
) -> Result<PublishResult, EditorError> {
    state.publish_target(&endpoint, target)
}

#[tauri::command]
fn cmd_take_page_preview(
    state: tauri::State<'_, ShellState>,
    target: SceneTarget,
    values: BTreeMap<String, ControlValue>,
) -> Result<SceneDocument, EditorError> {
    take_page_preview(&state.workspace(), &target, &values)
}

/// The creatable kinds, read from Rust so the menu cannot offer a kind the
/// contract would refuse (invariant 18).
#[tauri::command]
fn cmd_object_kinds() -> Vec<&'static str> {
    gx_contracts::authoring::CREATABLE_KINDS.to_vec()
}

#[tauri::command]
fn cmd_animation_surface() -> AnimationSurface {
    animation_surface()
}

#[tauri::command]
fn cmd_control_properties(kind: String) -> Vec<(String, ControlFieldKind)> {
    fillable_properties(&kind)
        .iter()
        .map(|(property, kind)| ((*property).to_owned(), *kind))
        .collect()
}

#[tauri::command]
fn cmd_starter_presets() -> Vec<MotionPreset> {
    starter_presets()
}

/// The starter presets followed by the project's saved ones (11.15), so the
/// picker lists exactly what `ApplyPreset` will resolve. A project that
/// cannot be read is an error, never a quietly shorter library.
#[tauri::command]
fn cmd_motion_presets(project: Option<String>) -> Result<Vec<MotionPreset>, EditorError> {
    let mut presets = starter_presets();
    if let Some(project) = project {
        presets.extend(
            projects()?
                .motion_presets(&project)
                .map_err(project_error)?,
        );
    }
    Ok(presets)
}

#[tauri::command]
fn cmd_default_endpoint() -> &'static str {
    DEFAULT_ASSET_ENDPOINT
}

#[tauri::command]
fn cmd_project_list() -> Result<Vec<String>, EditorError> {
    projects()?.list_projects().map_err(project_error)
}

#[tauri::command]
fn cmd_scene_list(project: String) -> Result<ProjectSceneCatalog, EditorError> {
    scene_catalog(&projects()?, &project)
}

#[tauri::command]
fn cmd_scene_read(project: String, scene_id: String) -> Result<SceneDocument, EditorError> {
    scene_read(&projects()?, &project, &scene_id)
}

#[tauri::command]
fn cmd_take_page_list(project: String) -> Result<ProjectTakePageCatalog, EditorError> {
    take_page_catalog(&projects()?, &project)
}

/// Reopen one saved instance exactly as its operator values were saved.
#[tauri::command]
fn cmd_take_page_read(project: String, page_id: String) -> Result<TakePage, EditorError> {
    projects()?
        .read_take_page(&project, &page_id)
        .map_err(project_error)
}

/// Verify font files the author picked and cache their bytes by content hash.
///
/// Writes only the content-addressed cache, never the scene: the returned
/// batch reaches the document as one `addFonts` edit through `cmd_execute`,
/// which is what makes one ingest one undo entry (11.13). All or nothing — one
/// unreadable or invalid file refuses the batch by that file's name.
#[tauri::command]
fn cmd_font_prepare_files(
    state: tauri::State<'_, ShellState>,
    target: SceneTarget,
    paths: Vec<String>,
    embedding_policy: EmbeddingPolicy,
    license: Option<String>,
) -> Result<PreparedFontBatch, EditorError> {
    let scene = state
        .workspace()
        .document(&target)
        .map_err(|error| command_error(error, None))?
        .into_owned();
    let mut files = Vec::with_capacity(paths.len());
    for path in &paths {
        let bytes = std::fs::read(path).map_err(|error| EditorError::ReadFile {
            path: path.clone(),
            detail: error.to_string(),
        })?;
        let name = std::path::Path::new(path)
            .file_name()
            .map_or_else(|| path.clone(), |name| name.to_string_lossy().into_owned());
        files.push((name, bytes));
    }
    let inputs: Vec<FontFileInput<'_>> = files
        .iter()
        .map(|(file_name, bytes)| FontFileInput {
            file_name: file_name.clone(),
            bytes,
            embedding_policy,
            license: license.clone(),
        })
        .collect();
    let library = SceneFontLibrary {
        fonts: &scene.fonts,
        assets: &scene.assets,
    };
    state.with_asset_store(|store| {
        prepare_font_files(store, library, &inputs).map_err(ingest_refused)
    })
}

/// Download a Google, Bunny or Adobe Fonts link into the asset cache
/// (docs/p2-licensing-positions.md §5). Like file ingest, it returns a batch
/// for one `addFonts` edit and never touches the scene. The network fetch runs
/// under the asset-cache lock only, never under the workspace lock.
#[tauri::command]
fn cmd_font_prepare_link(
    state: tauri::State<'_, ShellState>,
    target: SceneTarget,
    link: String,
) -> Result<PreparedFontBatch, EditorError> {
    let scene = state
        .workspace()
        .document(&target)
        .map_err(|error| command_error(error, None))?
        .into_owned();
    let source = linked_source(&link);
    let library = SceneFontLibrary {
        fonts: &scene.fonts,
        assets: &scene.assets,
    };
    state.with_asset_store(|store| {
        prepare_font_link(store, &UreqFontFetcher::new(), library, &source).map_err(ingest_refused)
    })
}

/// Import the image, SVG, video and 3D model files the author picked into
/// the asset cache (11.39). Like font ingest it never touches the scene: the
/// batch, each asset already carrying the provenance the import filled in,
/// reaches the document as one `addAssets` edit through `cmd_execute`. All or
/// nothing; a file whose bytes are no format the asset manager reads refuses
/// the batch by that file's name.
#[tauri::command]
fn cmd_asset_prepare_files(
    state: tauri::State<'_, ShellState>,
    target: SceneTarget,
    paths: Vec<String>,
) -> Result<PreparedAssetBatch, EditorError> {
    let scene = state
        .workspace()
        .document(&target)
        .map_err(|error| command_error(error, None))?
        .into_owned();
    let mut files = Vec::with_capacity(paths.len());
    for path in &paths {
        let bytes = std::fs::read(path).map_err(|error| EditorError::ReadFile {
            path: path.clone(),
            detail: error.to_string(),
        })?;
        let name = std::path::Path::new(path)
            .file_name()
            .map_or_else(|| path.clone(), |name| name.to_string_lossy().into_owned());
        files.push((name, bytes));
    }
    let inputs: Vec<AssetFileInput<'_>> = files
        .iter()
        .map(|(file_name, bytes)| AssetFileInput {
            file_name: file_name.clone(),
            bytes,
        })
        .collect();
    state.with_asset_store(|store| {
        prepare_asset_files(store, &scene.assets, &inputs).map_err(|refusal| {
            EditorError::CommandRefused {
                detail: refusal.to_string(),
                cause: refusal.refusal,
            }
        })
    })
}

/// What the author typed. The classification lives in the asset plane so the
/// shell, the tests and any other caller cannot disagree: an Adobe kit URL or
/// bare kit id is an Adobe Fonts link, a URL ending .ttf/.otf/.woff/.woff2 is a
/// direct font file, anything else a stylesheet URL. `prepare_font_link` then
/// refuses whatever is not a trusted host or a valid source, by name.
fn linked_source(link: &str) -> LinkedSource {
    gx_asset_plane::fonts::manager::linked_source_from_input(link)
}

/// The verified bytes of one cached font asset, for the browser's font
/// registration. The hash is checked as a SHA-256 address before it touches a
/// path, and the bytes are re-hashed before they leave: a cache entry that no
/// longer matches its name is refused, never served.
#[tauri::command]
fn cmd_font_bytes(
    state: tauri::State<'_, ShellState>,
    checksum: ContentHash,
) -> Result<tauri::ipc::Response, EditorError> {
    // A checksum that is not a content address is never made into a path,
    // and the bytes are re-hashed before they are served (invariant 27).
    let bytes = state.with_asset_store(|store| {
        store
            .read_verified(&checksum, MAX_PACKAGE_BYTES)
            .map_err(|error| cache_read_failed(error, &checksum))
    })?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// What taking assets into a project did, by asset id. Nothing is summarised
/// into a count: an asset that could not be taken in is named with the reason.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptReport {
    /// Newly written into the project's asset folder.
    pub adopted: Vec<String>,
    /// Already there; the record was refreshed, the bytes untouched.
    pub already_present: Vec<String>,
    /// Neither the project nor the import cache holds verifiable bytes.
    pub missing: Vec<AdoptMissing>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptMissing {
    pub asset_id: String,
    pub reason: String,
}

/// Take assets into a project so the project folder owns them (build plan
/// 11.18). Bytes come from the project if it already holds them, otherwise
/// from the shared import cache, which is where an import lands first; either
/// way they are re-hashed against the asset's address before they are filed.
#[tauri::command]
fn cmd_project_assets_adopt(
    state: tauri::State<'_, ShellState>,
    project: String,
    items: Vec<AssetLibraryItem>,
) -> Result<AdoptReport, EditorError> {
    let projects = projects()?;
    let mut report = AdoptReport {
        adopted: Vec::new(),
        already_present: Vec::new(),
        missing: Vec::new(),
    };
    for item in &items {
        let Some(hash) = item.checksum.clone() else {
            report.missing.push(AdoptMissing {
                asset_id: item.asset_id.clone(),
                reason: "no content hash has arrived for this asset".into(),
            });
            continue;
        };
        if let Some(bytes) = projects
            .read_asset(&project, &hash)
            .map_err(project_error)?
        {
            projects
                .adopt_asset(&project, item, &bytes)
                .map_err(project_error)?;
            report.already_present.push(item.asset_id.clone());
            continue;
        }
        let cached = state
            .with_asset_store(|store| Ok(store.cache_path(&hash)))
            .ok()
            .and_then(|path| std::fs::read(path).ok());
        match cached {
            Some(bytes) if content_hash(&bytes) == hash => {
                projects
                    .adopt_asset(&project, item, &bytes)
                    .map_err(project_error)?;
                report.adopted.push(item.asset_id.clone());
            }
            Some(_) => report.missing.push(AdoptMissing {
                asset_id: item.asset_id.clone(),
                reason: "the cached bytes no longer match the asset's content hash".into(),
            }),
            None => report.missing.push(AdoptMissing {
                asset_id: item.asset_id.clone(),
                reason:
                    "the bytes are in neither the project nor the import cache; re-import the file"
                        .into(),
            }),
        }
    }
    Ok(report)
}

/// Every asset the project's own folder holds, so a scene can reuse one the
/// project already has instead of importing it again.
#[tauri::command]
fn cmd_project_assets(project: String) -> Result<Vec<AssetLibraryItem>, EditorError> {
    projects()?.project_assets(&project).map_err(project_error)
}

/// The verified bytes of one asset, for previews: the project's copy when a
/// project is named and holds it, otherwise the import cache. The address is
/// checked as a SHA-256 before it touches a path, and the bytes are re-hashed
/// before they leave.
#[tauri::command]
fn cmd_asset_bytes(
    state: tauri::State<'_, ShellState>,
    project: Option<String>,
    checksum: ContentHash,
) -> Result<tauri::ipc::Response, EditorError> {
    let valid = checksum.0.len() == 64
        && checksum
            .0
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !valid {
        return Err(refused(Refusal::AssetMissing { hash: checksum }));
    }
    if let Some(project) = project {
        if let Some(bytes) = projects()?
            .read_asset(&project, &checksum)
            .map_err(project_error)?
        {
            return Ok(tauri::ipc::Response::new(bytes));
        }
    }
    let path = state.with_asset_store(|store| Ok(store.cache_path(&checksum)))?;
    let bytes = std::fs::read(&path).map_err(|_| {
        refused(Refusal::AssetMissing {
            hash: checksum.clone(),
        })
    })?;
    if content_hash(&bytes) != checksum {
        return Err(refused(Refusal::AssetHashMismatch {
            expected: checksum,
            actual: content_hash(&bytes),
        }));
    }
    Ok(tauri::ipc::Response::new(bytes))
}

/// 2.13: the front end's own record of what it did and what went wrong in it,
/// written to this shell's log. Only what `gx_telemetry::ui` accepts is written;
/// an entry of another kind, or with another field, is refused.
#[tauri::command]
fn cmd_log(entry: gx_telemetry::ui::UiEntry) -> Result<(), String> {
    gx_telemetry::ui::record(entry).map_err(|refusal| refusal.to_string())
}

/// Build and run the Editor window.
pub fn run() {
    // 2.12: the Editor's log, from here until the window closes.
    let mut log = gx_telemetry::sink::init_process_logging("editor", "shell");
    tracing::info!(event = "editor.start", version = env!("CARGO_PKG_VERSION"));
    let workspace = Workspace::new(projects().ok());
    let built = gx_shell_log::with_diagnostics_menu(tauri::Builder::default(), "editor")
        .manage(ShellState::new(workspace))
        .plugin(tauri_plugin_dialog::init())
        // 2.13: each command runs inside the scope of its call's correlation id.
        .invoke_handler(gx_shell_log::scoped(tauri::generate_handler![
            cmd_log,
            cmd_execute,
            cmd_import_file,
            cmd_session_view,
            cmd_publish,
            cmd_take_page_preview,
            cmd_object_kinds,
            cmd_animation_surface,
            cmd_control_properties,
            cmd_starter_presets,
            cmd_motion_presets,
            cmd_default_endpoint,
            cmd_project_list,
            cmd_scene_list,
            cmd_scene_read,
            cmd_take_page_list,
            cmd_take_page_read,
            cmd_font_prepare_files,
            cmd_font_prepare_link,
            cmd_font_bytes,
            cmd_asset_prepare_files,
            cmd_project_assets_adopt,
            cmd_project_assets,
            cmd_asset_bytes,
        ]))
        .build(tauri::generate_context!());
    let app = match built {
        Ok(app) => app,
        Err(error) => {
            tracing::error!(event = "editor.failed", detail = %error);
            stopped(&mut log, "the shell failed to start");
            panic!("the Editor shell failed to start: {error}");
        }
    };
    app.run(move |_app, event| {
        if let tauri::RunEvent::Exit = event {
            stopped(&mut log, "the window closed");
        }
    });
}

/// The Editor's last record, then its log written out (2.12). Called when the
/// window has closed: the event loop does not return to `run`, so nothing
/// after it would be reached.
fn stopped(log: &mut Option<gx_telemetry::sink::LogGuard>, reason: &str) {
    tracing::info!(event = "editor.stop", reason);
    if let Some(guard) = log.take() {
        let _ = guard.finish();
    }
}

#[cfg(test)]
mod tests {
    /// The tests that capture this process's log take this one at a time: a
    /// capture that runs beside another lost records (2 runs in 20), because
    /// `tracing` keeps its per-call-site "is anyone listening" answer for the whole
    /// process.
    static LOG_CAPTURE: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A process-wide subscriber that records nothing, installed once before a
    /// capture. With only one scoped subscriber alive, `tracing` decides whether a
    /// call site is listened to from the thread that first reaches it; a test on
    /// another thread then marks `editor.command` as unheard for the whole process
    /// and the capture loses it. With a global subscriber there is never just one.
    fn install_quiet_global_subscriber() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let _ = tracing::dispatcher::set_global_default(tracing::Dispatch::new(
                tracing_subscriber::registry(),
            ));
        });
    }

    use gx_contracts::command::{CreateObject, DeclareControl, EditScene, SceneEdit};
    use gx_contracts::control::ControlField;

    use super::*;

    /// 2.12: closing the window leaves `editor.stop` and then the sink's own
    /// `log.stop` as the file's last two records.
    #[test]
    fn closing_writes_a_stop_record_and_ends_the_log() {
        use tracing_subscriber::layer::SubscriberExt;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("gx-editor-stop-{}-{nanos}", std::process::id()));
        let guard =
            gx_telemetry::sink::start(gx_telemetry::sink::LogConfig::new("editor", "shell", &dir))
                .unwrap();
        let subscriber = tracing_subscriber::registry().with(guard.layer());
        let mut log = Some(guard);
        install_quiet_global_subscriber();
        let _alone = LOG_CAPTURE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(event = "editor.start");
            stopped(&mut log, "the window closed");
        });
        assert!(log.is_none(), "the log is finished, not left to a drop");
        let mut events = Vec::new();
        for entry in std::fs::read_dir(dir.join("editor")).unwrap().flatten() {
            for line in std::fs::read_to_string(entry.path()).unwrap().lines() {
                let record: serde_json::Value = serde_json::from_str(line).unwrap();
                events.push((
                    record["event"].as_str().unwrap().to_owned(),
                    record["fields"]["reason"].as_str().map(str::to_owned),
                ));
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        let last: Vec<_> = events.iter().rev().take(2).rev().cloned().collect();
        assert_eq!(
            last,
            vec![
                (
                    "editor.stop".to_owned(),
                    Some("the window closed".to_owned())
                ),
                ("log.stop".to_owned(), None),
            ],
            "{events:?}"
        );
    }

    // --- 2.17: a publish names the edits it carries ------------------------------

    /// Run `body` with this thread's events going to a fresh sink; the shell's
    /// records, parsed.
    fn recorded(label: &str, body: impl FnOnce()) -> Vec<serde_json::Value> {
        use tracing_subscriber::layer::SubscriberExt;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "gx-editor-carry-{label}-{}-{nanos}",
            std::process::id()
        ));
        let guard =
            gx_telemetry::sink::start(gx_telemetry::sink::LogConfig::new("editor", "shell", &dir))
                .unwrap();
        install_quiet_global_subscriber();
        let _alone = LOG_CAPTURE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        tracing::subscriber::with_default(tracing_subscriber::registry().with(guard.layer()), body);
        guard.finish().unwrap();
        let mut records: Vec<serde_json::Value> = Vec::new();
        for entry in std::fs::read_dir(dir.join("editor")).unwrap().flatten() {
            for line in std::fs::read_to_string(entry.path()).unwrap().lines() {
                records.push(serde_json::from_str(line).unwrap());
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        records
    }

    fn create_rect(session: SessionKey, kind: &str) -> EditorCommand {
        EditorCommand::EditScene(EditScene {
            target: gx_contracts::command::SceneTarget::Session { session },
            edits: vec![SceneEdit::CreateObject(CreateObject {
                kind: kind.into(),
                name: "Bar".into(),
            })],
            module: None,
            if_revision: None,
        })
    }

    #[test]
    fn the_ledger_keeps_the_newest_ids_per_target_and_forgets_only_what_was_published() {
        let mut ledger = EditLedger::default();
        // One shell call is one id, however many edits it made.
        ledger.record("session:1", "ed-1");
        ledger.record("session:1", "ed-1");
        ledger.record("session:1", "ed-2");
        ledger.record("session:2", "ed-9");
        assert_eq!(ledger.snapshot("session:1").ids, ["ed-1", "ed-2"]);
        assert_eq!(ledger.snapshot("session:2").ids, ["ed-9"]);
        assert!(ledger.snapshot("session:3").ids.is_empty());

        // A publish carried the first two; an edit made while it ran stays.
        let carried = ledger.snapshot("session:1");
        ledger.record("session:1", "ed-3");
        ledger.forget("session:1", &carried);
        assert_eq!(ledger.snapshot("session:1").ids, ["ed-3"]);
        assert_eq!(
            ledger.snapshot("session:2").ids,
            ["ed-9"],
            "another target is untouched"
        );
        ledger.forget("session:1", &ledger.snapshot("session:1"));
        assert!(
            !ledger.targets.contains_key("session:1"),
            "an empty target is let go"
        );

        // Hundreds of edits: the newest are kept, the older are counted.
        let limit = gx_telemetry::corr::MAX_CARRIED;
        for n in 0..limit + 10 {
            ledger.record("session:5", &format!("ed-{n}"));
        }
        let kept = ledger.snapshot("session:5");
        assert_eq!(kept.ids.len(), limit);
        assert_eq!(kept.dropped, 10);
        assert_eq!(kept.ids.first().map(String::as_str), Some("ed-10"));
        assert_eq!(
            kept.ids.last().map(String::as_str),
            Some(&*format!("ed-{}", limit + 9))
        );
        ledger.forget("session:5", &kept);
        assert!(ledger.snapshot("session:5").ids.is_empty());
        assert!(
            !ledger.targets.contains_key("session:5"),
            "published whole, let go"
        );

        // A full list, a publish taken, then one more edit while it is in flight:
        // the new edit pushes the oldest id out. The publish carried the 64 it
        // took, the one pushed out among them, so afterwards exactly the new edit
        // is left and nothing is counted as unnamed.
        for n in 0..limit {
            ledger.record("session:6", &format!("ed-a{n}"));
        }
        let taken = ledger.snapshot("session:6");
        assert_eq!((taken.ids.len(), taken.dropped), (limit, 0));
        ledger.record("session:6", "ed-during");
        ledger.forget("session:6", &taken);
        let left = ledger.snapshot("session:6");
        assert_eq!(left.ids, ["ed-during"]);
        assert_eq!(left.dropped, 0);

        // More than the limit of edits while one publish is in flight: the ones
        // let go after it was taken were not published, and stay counted.
        let taken = ledger.snapshot("session:6");
        for n in 0..limit + 3 {
            ledger.record("session:6", &format!("ed-b{n}"));
        }
        ledger.forget("session:6", &taken);
        let left = ledger.snapshot("session:6");
        assert_eq!(left.ids.len(), limit);
        assert_eq!(
            left.ids.last().map(String::as_str),
            Some(&*format!("ed-b{}", limit + 2))
        );
        assert!(left.dropped >= 3, "{}", left.dropped);

        // A publish taken of a target with no edits forgets nothing made after it.
        let taken = ledger.snapshot("session:7");
        ledger.record("session:7", "ed-later");
        ledger.forget("session:7", &taken);
        assert_eq!(ledger.snapshot("session:7").ids, ["ed-later"]);

        // The ledger follows a bounded number of targets.
        for n in 0..MAX_LEDGER_TARGETS + 5 {
            ledger.record(&format!("project/scene-{n}"), "ed-x");
        }
        assert_eq!(ledger.targets.len(), MAX_LEDGER_TARGETS);
        assert!(ledger.targets.contains_key("project/scene-0"));
        assert!(!ledger
            .targets
            .contains_key(&format!("project/scene-{}", MAX_LEDGER_TARGETS + 4)));
    }

    #[test]
    fn an_edit_is_noted_by_the_id_of_the_call_that_made_it_and_nothing_else_is() {
        let state = ShellState::new(Workspace::new(None));
        let open = |id: &str| {
            let _call = gx_telemetry::corr::enter(id);
            state
                .execute_command(EditorCommand::OpenScene(gx_contracts::command::OpenScene {
                    source: gx_contracts::command::SceneSource::New {
                        id: "card".into(),
                        name: "Card".into(),
                    },
                }))
                .expect("a new scene opens")
                .session
                .expect("a session")
                .session
        };
        let session = open("ed-open");
        {
            let _call = gx_telemetry::corr::enter("ed-edit-1");
            state
                .execute_command(create_rect(session, "rect"))
                .expect("applies");
        }
        {
            // Refused: it changed nothing, so it is not carried.
            let _call = gx_telemetry::corr::enter("ed-refused");
            assert!(state
                .execute_command(create_rect(session, "no-such-kind"))
                .is_err());
        }
        {
            let _call = gx_telemetry::corr::enter("ed-edit-2");
            state
                .execute_command(create_rect(session, "rect"))
                .expect("applies");
        }
        // No id in scope: the edit applies and there is nothing to name.
        state
            .execute_command(create_rect(session, "rect"))
            .expect("applies");
        let key = format!("session:{}", session.0);
        assert_eq!(state.edits().snapshot(&key).ids, ["ed-edit-1", "ed-edit-2"]);
        assert!(!state.edits().targets.contains_key("session:999"));
    }

    /// 2.17: whether the workspace is held right now (without waiting for it).
    fn workspace_is_held(state: &ShellState) -> bool {
        matches!(
            state.workspace.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        )
    }

    /// Whether the workspace stays held, from a moment `held` is first true, for
    /// a settle time long enough for a thread that released it to have done so.
    fn stays_held(state: &ShellState) -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !workspace_is_held(state) {
            if std::time::Instant::now() > deadline {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        // It is held: the thread that took it is now waiting on the ledger,
        // which the test holds. If it let go of the workspace first, the lock
        // frees within this time.
        let settle = std::time::Instant::now() + std::time::Duration::from_millis(400);
        while std::time::Instant::now() < settle {
            if !workspace_is_held(state) {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        true
    }

    fn open_card(state: &ShellState) -> SessionKey {
        let _call = gx_telemetry::corr::enter("ed-open");
        state
            .execute_command(EditorCommand::OpenScene(gx_contracts::command::OpenScene {
                source: gx_contracts::command::SceneSource::New {
                    id: "card".into(),
                    name: "Card".into(),
                },
            }))
            .expect("a new scene opens")
            .session
            .expect("a session")
            .session
    }

    /// 2.17: the document a publish holds and the edits it names are read under
    /// one hold of the workspace, so an edit that lands between the two cannot be
    /// named by a publish whose document lacks it. The test holds the ledger
    /// and starts the read: it takes the workspace, copies the document, and waits
    /// for the ledger. While it waits the workspace must stay held.
    #[test]
    fn the_document_and_its_edits_are_read_under_one_hold_of_the_workspace() {
        let state = std::sync::Arc::new(ShellState::new(Workspace::new(None)));
        let session = open_card(&state);
        let ledger = state.edits();
        let reader = {
            let state = std::sync::Arc::clone(&state);
            std::thread::spawn(move || {
                let target = gx_contracts::command::SceneTarget::Session { session };
                state.document_and_edits(&target).expect("reads");
            })
        };
        assert!(
            stays_held(&state),
            "the workspace was let go before the ledger was read"
        );
        drop(ledger);
        reader.join().expect("the read finished");
    }

    /// 2.17: an edit is noted in the ledger under the same hold of the workspace
    /// that applied it, so a reader sees the edit and its note together or
    /// neither. The test holds the ledger and makes an edit: it applies it, and
    /// waits to note it. While it waits the workspace must stay held.
    #[test]
    fn an_edit_is_noted_under_the_same_hold_of_the_workspace_that_applied_it() {
        let state = std::sync::Arc::new(ShellState::new(Workspace::new(None)));
        let session = open_card(&state);
        let ledger = state.edits();
        let writer = {
            let state = std::sync::Arc::clone(&state);
            std::thread::spawn(move || {
                let _call = gx_telemetry::corr::enter("ed-held");
                state
                    .execute_command(create_rect(session, "rect"))
                    .expect("applies");
            })
        };
        assert!(
            stays_held(&state),
            "the workspace was let go before the edit was noted"
        );
        drop(ledger);
        writer.join().expect("the edit finished");
        assert_eq!(
            state
                .edits()
                .snapshot(&format!("session:{}", session.0))
                .ids,
            ["ed-held"]
        );
    }

    #[test]
    fn a_failed_publish_names_its_edits_on_record_and_keeps_them_for_the_next_try() {
        let scratch = Scratch::new("carry");
        let state = ShellState::new(Workspace::new(None))
            .with_asset_root(scratch.0.join("assets"))
            .with_package_directory(scratch.0.join("packages"));
        let mut session = None;
        let records = recorded("failed", || {
            let opened = state
                .execute_command(EditorCommand::OpenScene(gx_contracts::command::OpenScene {
                    source: gx_contracts::command::SceneSource::New {
                        id: "card".into(),
                        name: "Card".into(),
                    },
                }))
                .expect("a new scene opens");
            let key = opened.session.expect("a session").session;
            session = Some(key);
            for id in ["ed-edit-1", "ed-edit-2"] {
                let _call = gx_telemetry::corr::enter(id);
                state
                    .execute_command(create_rect(key, "rect"))
                    .expect("applies");
            }
            let _publish = gx_telemetry::corr::enter("ed-pub-1");
            // Nothing listens on port 1: the publish fails and nothing is published.
            let result = state.publish_target(
                "127.0.0.1:1",
                gx_contracts::command::SceneTarget::Session { session: key },
            );
            assert!(
                matches!(result, Err(EditorError::Unreachable { .. })),
                "{result:?}"
            );
        });
        let failed = records
            .iter()
            .find(|r| r["event"] == "editor.publish" && r["fields"]["result"] == "failed")
            .unwrap_or_else(|| panic!("no failed publish in {records:#?}"));
        assert_eq!(failed["corr"], "ed-pub-1");
        assert_eq!(failed["fields"]["carries"], "ed-edit-1,ed-edit-2");
        assert!(
            failed["fields"].get("carries_dropped").is_none(),
            "{failed}"
        );
        let key = format!("session:{}", session.expect("a session").0);
        assert_eq!(
            state.edits().snapshot(&key).ids,
            ["ed-edit-1", "ed-edit-2"],
            "a failed publish forgets nothing"
        );
        // Each edit is on record under its own id, which is what a search for it finds.
        for id in ["ed-edit-1", "ed-edit-2"] {
            assert!(
                records
                    .iter()
                    .any(|r| r["event"] == "editor.command" && r["corr"] == id),
                "{id}"
            );
        }
    }

    /// 2.12: a command applied and a command refused, each on record with its
    /// name, target, effects or refusal code.
    #[test]
    fn every_editor_command_and_its_answer_is_on_record() {
        use tracing_subscriber::layer::SubscriberExt;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("gx-editor-log-{}-{nanos}", std::process::id()));
        let guard =
            gx_telemetry::sink::start(gx_telemetry::sink::LogConfig::new("editor", "shell", &dir))
                .unwrap();
        let subscriber = tracing_subscriber::registry().with(guard.layer());
        install_quiet_global_subscriber();
        let _alone = LOG_CAPTURE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        tracing::subscriber::with_default(subscriber, || {
            // `tracing` caches, per call site and per process, whether anyone is
            // listening. Another test that ran an editor command before this
            // capture existed can have cached "nobody" for `editor.command`, and
            // the capture then loses the record (2 runs in 20 in parallel). Ask
            // tracing to recompute that cache now that this capture is installed.
            tracing::callsite::rebuild_interest_cache();
            let mut workspace = Workspace::new(None);
            let opened = execute(
                &mut workspace,
                EditorCommand::OpenScene(gx_contracts::command::OpenScene {
                    source: gx_contracts::command::SceneSource::New {
                        id: "card".into(),
                        name: "Card".into(),
                    },
                }),
            )
            .expect("a new scene opens");
            let session = opened.session.expect("a session").session;
            execute(
                &mut workspace,
                EditorCommand::EditScene(EditScene {
                    target: gx_contracts::command::SceneTarget::Session { session },
                    edits: vec![SceneEdit::CreateObject(CreateObject {
                        kind: "rect".into(),
                        name: "Bar".into(),
                    })],
                    module: None,
                    if_revision: None,
                }),
            )
            .expect("the edit applies");
            let _ = execute(
                &mut workspace,
                EditorCommand::EditScene(EditScene {
                    target: gx_contracts::command::SceneTarget::Session { session },
                    edits: vec![SceneEdit::CreateObject(CreateObject {
                        kind: "no-such-kind".into(),
                        name: "X".into(),
                    })],
                    module: None,
                    if_revision: None,
                }),
            );
        });
        guard.finish().unwrap();
        let mut records: Vec<serde_json::Value> = Vec::new();
        for entry in std::fs::read_dir(dir.join("editor")).unwrap().flatten() {
            for line in std::fs::read_to_string(entry.path()).unwrap().lines() {
                records.push(serde_json::from_str(line).unwrap());
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        let applied = records
            .iter()
            .find(|r| {
                r["event"] == "editor.command"
                    && r["fields"]["command"] == "editScene"
                    && r["fields"]["result"] == "applied"
            })
            .unwrap_or_else(|| panic!("no applied edit in {records:#?}"));
        assert_eq!(applied["fields"]["edits"], 1);
        assert!(applied["fields"]["target"]
            .as_str()
            .is_some_and(|t| t.starts_with("session:")));
        assert!(applied["fields"]["effects"]
            .as_str()
            .is_some_and(|e| e.contains("objectCreated")));
        let refused = records
            .iter()
            .find(|r| r["event"] == "editor.command" && r["fields"]["result"] == "refused")
            .unwrap_or_else(|| panic!("no refused edit in {records:#?}"));
        assert!(refused["refusal"].as_str().is_some(), "{refused}");
        assert!(records
            .iter()
            .any(|r| r["event"] == "editor.command" && r["fields"]["command"] == "openScene"));
    }

    #[test]
    fn a_failed_read_of_the_editors_own_cache_is_never_blamed_on_the_engine() {
        let hash = content_hash(b"cache entry");
        let held = AssetStoreError::ReadCache {
            path: "secret-cache-entry".into(),
            source: std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        };
        let error = cache_read_failed(held, &hash);
        match &error {
            EditorError::AssetCache { detail } => {
                assert!(detail.contains(&hash.0), "{detail}");
                assert!(!detail.contains("secret"), "{detail}");
            }
            other => panic!("expected the cache error, got {other:?}"),
        }
        assert!(!error.to_string().contains("engine"), "{error}");

        // An entry too long to read is the cache's problem too.
        let grown = AssetStoreError::Refusal(Refusal::AssetStoreFailed {
            hash: hash.clone(),
            detail: "the entry is 9 bytes, more than the 8 it may hold".into(),
        });
        assert!(matches!(
            cache_read_failed(grown, &hash),
            EditorError::AssetCache { .. }
        ));

        // A missing or altered entry keeps its name.
        let missing = AssetStoreError::Refusal(Refusal::AssetMissing { hash: hash.clone() });
        assert!(matches!(
            cache_read_failed(missing, &hash),
            EditorError::CommandRefused {
                cause: Refusal::AssetMissing { .. },
                ..
            }
        ));
        let altered = AssetStoreError::Refusal(Refusal::AssetHashMismatch {
            expected: hash.clone(),
            actual: content_hash(b"other"),
        });
        assert!(matches!(
            cache_read_failed(altered, &hash),
            EditorError::CommandRefused {
                cause: Refusal::AssetHashMismatch { .. },
                ..
            }
        ));
    }

    #[cfg(windows)]
    #[test]
    fn publishing_from_a_cache_entry_another_process_holds_names_the_cache() {
        use gx_contracts::scene::{new_scene, AssetKind, AssetLibraryItem};
        use std::os::windows::fs::OpenOptionsExt;

        let root = std::env::temp_dir().join(format!("gx-shell-held-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let store = AssetStore::at_root(root.clone());
        let bytes = b"a cached asset".to_vec();
        let hash = content_hash(&bytes);
        store.promote_verified(&hash, &bytes).unwrap();
        let mut scene = new_scene(
            "shell/held",
            "Held",
            gx_contracts::color::WorkingColorSpace::LinearSrgb,
        );
        scene.assets.push(AssetLibraryItem {
            asset_id: "held".into(),
            name: "Held".into(),
            kind: AssetKind::Image,
            path: "images/held.png".into(),
            checksum: Some(hash.clone()),
            mime_type: None,
            size_bytes: Some(bytes.len() as u64),
            status: None,
            provenance: Default::default(),
            color_space: None,
        });
        // A scanner or backup tool holding the entry without sharing it.
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(store.cache_path(&hash))
            .unwrap();
        let refused = package_sources(&scene, &store)
            .map_err(|failure| publish_error(failure, None))
            .unwrap_err();
        drop(held);
        assert!(
            matches!(&refused, EditorError::AssetCache { detail } if detail.contains(&hash.0)),
            "expected the cache error, got {refused:?}"
        );
        assert!(!refused.to_string().contains("engine"), "{refused}");
        // Once the other process lets go, the same publish reads it.
        assert_eq!(package_sources(&scene, &store).unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_font_link_box_classifies_direct_files_stylesheets_and_adobe_kits() {
        let direct = |url: &str| matches!(linked_source(url), LinkedSource::DirectUrl { .. });
        for url in [
            "https://fonts.gstatic.com/s/inter/v13/abc.woff2?x=1",
            "https://fonts.gstatic.com/s/inter/v13/abc.WOFF",
            "https://fonts.gstatic.com/s/inter/v13/abc.ttf",
            "https://fonts.gstatic.com/s/inter/v13/abc.otf",
        ] {
            assert!(direct(url), "{url} should be a direct font file");
        }
        assert!(matches!(
            linked_source("https://fonts.googleapis.com/css2?family=Inter"),
            LinkedSource::CssUrl { .. }
        ));
        assert!(matches!(
            linked_source("https://use.typekit.net/abc1234.css"),
            LinkedSource::AdobeFonts { project_id } if project_id == "abc1234"
        ));
        assert!(matches!(
            linked_source("  abc1234  "),
            LinkedSource::AdobeFonts { project_id } if project_id == "abc1234"
        ));
        // A credential-bearing kit URL is not quietly turned into a kit id.
        assert!(!matches!(
            linked_source("https://user:pw@use.typekit.net/abc1234.css"),
            LinkedSource::AdobeFonts { .. }
        ));
    }

    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock after epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "gx-editor-shell-{label}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("scratch directory");
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Parse and run a command exactly as `cmd_execute` does.
    fn invoke(
        workspace: &mut Workspace,
        command: serde_json::Value,
    ) -> Result<CommandOutcome, EditorError> {
        execute(workspace, parse_command(command).map_err(refused)?)
    }

    fn open_new(workspace: &mut Workspace) -> SessionKey {
        invoke(workspace, serde_json::json!({ "command": "openScene", "source": { "source": "new", "id": "probe", "name": "Probe" } }))
            .expect("a new scene opens")
            .session
            .expect("an open reports its session")
            .session
    }

    #[test]
    fn an_unknown_command_field_is_refused_by_its_path_before_anything_runs() {
        let mut workspace = Workspace::new(None);
        let error = invoke(
            &mut workspace,
            serde_json::json!({
                "command": "openScene",
                "source": { "source": "new", "id": "probe", "name": "Probe", "scene": {} }
            }),
        )
        .expect_err("a smuggled field must refuse");
        assert!(
            matches!(&error, EditorError::CommandRefused { cause: Refusal::CommandUnknownField { path }, .. } if path == "source.scene"),
            "got {error:?}"
        );
        assert!(workspace.view(SessionKey(1)).is_err(), "nothing was opened");
    }

    #[test]
    fn a_workspace_refusal_reaches_the_web_layer_with_its_cause() {
        let mut workspace = Workspace::new(None);
        let error = invoke(
            &mut workspace,
            serde_json::json!({ "command": "undo", "session": 9 }),
        )
        .expect_err("no such session");
        assert!(
            matches!(
                error,
                EditorError::CommandRefused {
                    cause: Refusal::SessionUnknown {
                        session: SessionKey(9)
                    },
                    ..
                }
            ),
            "got {error:?}"
        );
    }

    #[test]
    fn a_scene_file_failure_names_the_file_and_the_direction() {
        let scratch = Scratch::new("files");
        let missing = scratch.0.join("absent.json").display().to_string();
        let mut workspace = Workspace::new(None);
        let error = invoke(
            &mut workspace,
            serde_json::json!({ "command": "openScene", "source": { "source": "file", "path": missing } }),
        )
        .expect_err("a missing file cannot open");
        assert!(
            matches!(&error, EditorError::ReadScene { path, .. } if path == &missing),
            "got {error:?}"
        );

        let session = open_new(&mut workspace);
        let unwritable = scratch
            .0
            .join("no-such-dir")
            .join("scene.json")
            .display()
            .to_string();
        let error = invoke(
            &mut workspace,
            serde_json::json!({ "command": "saveScene", "session": session.0, "to": { "to": "file", "path": unwritable } }),
        )
        .expect_err("a file in a missing directory cannot be written");
        assert!(
            matches!(&error, EditorError::WriteScene { path, .. } if path == &unwritable),
            "got {error:?}"
        );
        assert!(
            workspace.view(session).unwrap().path.is_none(),
            "a failed save records no path"
        );
    }

    #[test]
    fn the_object_menu_only_offers_kinds_the_contract_will_create() {
        // The menu is read from Rust so it cannot drift from what the create
        // edit accepts — a kind that appears and then refuses is the silent
        // gap invariant 18 exists to prevent.
        let kinds = cmd_object_kinds();
        assert!(!kinds.is_empty());
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace);
        for kind in kinds {
            let outcome = execute(
                &mut workspace,
                EditorCommand::EditScene(EditScene {
                    target: SceneTarget::Session { session },
                    edits: vec![SceneEdit::CreateObject(CreateObject {
                        kind: kind.into(),
                        name: "X".into(),
                    })],
                    module: None,
                    if_revision: None,
                }),
            );
            // `text` is the one creatable kind with a scene-level
            // prerequisite; a blank scene carries no fonts.
            if kind == "text" {
                assert!(
                    matches!(outcome, Err(EditorError::CommandRefused { .. })),
                    "text needs a font"
                );
            } else {
                assert!(
                    outcome.is_ok(),
                    "menu offers {kind} but the contract refuses it: {outcome:?}"
                );
            }
        }
    }

    #[test]
    fn take_page_preview_refuses_wrong_values_without_mutating_the_template() {
        let mut workspace = Workspace::new(None);
        let session = open_new(&mut workspace);
        execute(
            &mut workspace,
            EditorCommand::EditScene(EditScene {
                target: SceneTarget::Session { session },
                edits: vec![
                    SceneEdit::CreateObject(CreateObject {
                        kind: "rect".into(),
                        name: "Background".into(),
                    }),
                    SceneEdit::DeclareControl(DeclareControl {
                        field: ControlField {
                            field_id: "offset".into(),
                            label: "Horizontal offset".into(),
                            object_id: "rect-1".into(),
                            property: "x".into(),
                            kind: ControlFieldKind::Number,
                            default: Some(ControlValue::Number(0.0)),
                        },
                    }),
                ],
                module: None,
                if_revision: None,
            }),
        )
        .expect("the template is authored");
        let target = SceneTarget::Session { session };
        let original = workspace.view(session).unwrap();

        let error = take_page_preview(
            &workspace,
            &target,
            &BTreeMap::from([("offset".into(), ControlValue::Text("not a number".into()))]),
        )
        .expect_err("text must not be coerced into a numeric control");
        assert!(
            error
                .to_string()
                .contains("offset requires number, not text"),
            "the operator needs Rust's named type mismatch: {error}"
        );

        let filled = take_page_preview(
            &workspace,
            &target,
            &BTreeMap::from([("offset".into(), ControlValue::Number(42.0))]),
        )
        .expect("a matching value fills a copy");
        assert_ne!(
            filled, original.document,
            "the returned preview is the filled copy"
        );
        assert_eq!(
            workspace.view(session).unwrap(),
            original,
            "a preview cannot edit the template or its history"
        );
    }

    #[test]
    fn the_scene_catalog_names_unreadable_files_and_refuses_paths() {
        let scratch = Scratch::new("catalog");
        let store = Projects::at_root(&scratch.0);
        store.create_project("news").expect("create project");
        std::fs::write(scratch.0.join("news/scenes/bad.json"), b"{ not-json")
            .expect("write corrupt scene");

        let catalog = scene_catalog(&store, "news").expect("list scene catalog");
        assert_eq!(catalog.scenes.len(), 1);
        assert_eq!(catalog.scenes[0].scene_id, "bad");
        assert!(catalog.scenes[0]
            .unavailable_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("unreadable")));

        assert!(matches!(
            scene_catalog(&store, "../news"),
            Err(EditorError::CommandRefused {
                cause: Refusal::ProjectNameInvalid { .. },
                ..
            })
        ));
        assert!(matches!(
            scene_read(&store, "news", "../escape"),
            Err(EditorError::CommandRefused {
                cause: Refusal::SceneIdInvalid { .. },
                ..
            })
        ));
    }

    #[test]
    fn the_scene_manager_reads_graphics_without_a_design_system() {
        let scratch = Scratch::new("catalog-no-design-system");
        let store = Projects::at_root(&scratch.0);
        store.create_project("broadcast").unwrap();
        store
            .write_scene(
                "broadcast",
                &gx_contracts::scene::new_scene(
                    "score",
                    "Score",
                    gx_contracts::color::WorkingColorSpace::NEW_PROJECT,
                ),
            )
            .unwrap();
        store
            .write_scene(
                "broadcast",
                &gx_contracts::scene::new_scene(
                    "lower-third",
                    "Lower third",
                    gx_contracts::color::WorkingColorSpace::NEW_PROJECT,
                ),
            )
            .unwrap();
        // Legacy metadata must neither gate navigation nor be modified.
        let legacy = scratch.0.join("broadcast/design-system");
        std::fs::write(&legacy, b"legacy metadata, not a directory").unwrap();
        let catalog = scene_catalog(&store, "broadcast").unwrap();
        assert_eq!(catalog.scenes.len(), 2);
        assert!(catalog
            .scenes
            .iter()
            .all(|graphic| graphic.unavailable_reason.is_none()));
        assert_eq!(
            std::fs::read(&legacy).unwrap(),
            b"legacy metadata, not a directory"
        );
    }

    #[test]
    fn an_unparseable_endpoint_is_refused_before_any_socket_opens() {
        let error = publish_with_sources(
            "not-an-address",
            Path::new("unused"),
            gx_contracts::scene::new_scene(
                "demo",
                "Demo",
                gx_contracts::color::WorkingColorSpace::NEW_PROJECT,
            ),
            &[],
        )
        .expect_err("a malformed endpoint cannot be dialled");
        assert!(matches!(error, EditorError::InvalidEndpoint { .. }));
    }
}
