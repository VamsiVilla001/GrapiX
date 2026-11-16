//! Integration: the Editor shell's publish path reaches a real engine (5.10).
//!
//! This runs against the actual worker binary, so it needs it built. Cargo
//! does not build sibling binaries for a library's integration test, so the
//! test skips cleanly when the binary is absent rather than failing
//! (invariant 43: a skip is not a pass, and a missing binary is a skip).
//!
//! What it proves is the seam the unit tests cannot: that the Editor writes a
//! package into its folder, learns the route from the engine itself on the
//! asset-plane address it publishes to (no control client, no configured
//! locality), and that the revision it reports is the revision the engine
//! issued. A worker started with `--package-dir` is handed the package by
//! path; one started with `--lan` takes the missing bytes chunked.

use std::net::{Ipv4Addr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use gx_asset_plane::AssetHandoff;
use gx_contracts::scene::new_scene;
use gx_editor::publish::package_sources;
use gx_editor_shell::{publish_with_sources, EditorError};

/// The worker binary, next to this test executable in target/debug.
fn worker_binary() -> Option<PathBuf> {
    let current = std::env::current_exe().ok()?;
    // .../target/debug/deps/publish-xxxx -> .../target/debug
    let debug = current.parent()?.parent()?;
    let candidate = debug.join(if cfg!(windows) {
        "gx-render-worker.exe"
    } else {
        "gx-render-worker"
    });
    candidate.exists().then_some(candidate)
}

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind ephemeral");
    listener.local_addr().expect("local addr").port()
}

struct KillOnDrop(Child);
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A scratch directory, removed on drop.
struct Scratch(PathBuf);
impl Scratch {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "gx-editor-shell-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock after epoch")
                .as_nanos()
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

/// Start a worker and wait for its asset plane to accept connections.
///
/// The worker is given its own recovery journal. Without that it restores the
/// machine's real one, and a scene this test published on an earlier run
/// comes back as an existing revision — which is the engine behaving
/// correctly and the test not being isolated.
fn start_worker(binary: &Path, scratch: &Path, asset: u16, extra: &[String]) -> Option<KillOnDrop> {
    let child = KillOnDrop(
        Command::new(binary)
            // 2.12: a test process logs to a scratch folder, not the operator's log root.
            .env("GX_LOG_DIR", std::env::temp_dir().join("gx-test-logs"))
            .args([
                "--port",
                &free_port().to_string(),
                "--asset-port",
                &asset.to_string(),
                "--recovery-journal",
                &scratch.join("recovery.json").display().to_string(),
            ])
            .args(extra)
            // Detached so the long-lived worker does not hold the test
            // harness's output pipe open after the test wants to exit.
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()?,
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while std::time::Instant::now() < deadline {
        if TcpStream::connect((Ipv4Addr::LOCALHOST, asset)).is_ok() {
            return Some(child);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

fn package_dir_args(directory: &Path) -> Vec<String> {
    vec!["--package-dir".into(), directory.display().to_string()]
}

fn packages_in(directory: &Path) -> Vec<String> {
    std::fs::read_dir(directory)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default()
}

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../services/render-engine/worker/tests/fixtures")
}

/// The Inter lower third, with the font in an Editor asset store at `root`.
fn lower_third(
    id: &str,
    root: &Path,
) -> (
    gx_contracts::scene::SceneDocument,
    usize,
    gx_asset_plane::AssetStore,
) {
    let font = std::fs::read(fixtures().join("Inter-Regular.ttf")).expect("fixture font");
    let hash = gx_asset_plane::content_hash(&font);
    let store = gx_asset_plane::AssetStore::at_root(root.join("assets"));
    store
        .promote_verified(&hash, &font)
        .expect("the font enters the Editor's store");
    let mut scene = gx_contracts::scene::parse_scene_document(
        &std::fs::read(fixtures().join("gpu-lower-third-50.json")).expect("fixture scene"),
    )
    .expect("the fixture parses");
    scene.id = id.into();
    (scene, font.len(), store)
}

#[test]
fn an_authored_scene_publishes_by_path_to_a_real_engine_and_reports_its_revision() {
    let Some(binary) = worker_binary() else {
        eprintln!("SKIP: gx-render-worker binary not built");
        return;
    };
    let scratch = Scratch::new("by-path");
    let folder = scratch.0.join("packages");
    std::fs::create_dir_all(&folder).unwrap();
    let asset = free_port();
    let Some(_worker) = start_worker(&binary, &scratch.0, asset, &package_dir_args(&folder)) else {
        eprintln!("SKIP: the worker did not come up");
        return;
    };
    let endpoint = format!("127.0.0.1:{asset}");

    let scene = new_scene(
        "shell-demo",
        "Shell Demo",
        gx_contracts::color::WorkingColorSpace::NEW_PROJECT,
    );
    let first = publish_with_sources(&endpoint, &folder, scene.clone(), &[])
        .expect("a valid scene publishes");
    assert_eq!(first.take_id.0, "shell-demo");
    assert_eq!(first.revision.0, 1, "the first publication is revision 1");
    assert_eq!(
        first.handoff,
        AssetHandoff::LocalPath,
        "the engine declared co-located"
    );
    assert_eq!(first.transferred_bytes, 0);

    // Publishing is additive (invariant 30): the same id republished produces
    // a *new* revision rather than editing the one already issued. An Editor
    // that reported the old revision would send Playout to a stale take.
    let second =
        publish_with_sources(&endpoint, &folder, scene, &[]).expect("republishing is additive");
    assert_eq!(second.revision.0, 2, "a republish issues the next revision");
    assert!(
        packages_in(&folder).is_empty(),
        "each package is removed after its reply: {:?}",
        packages_in(&folder)
    );
}

#[test]
fn an_unreachable_asset_plane_is_not_reported_as_a_refusal() {
    // Nothing is listening here. The distinction matters: a refusal means the
    // engine decided, and an author must not be told their document was
    // rejected when it was never seen (invariant 17).
    let scratch = Scratch::new("unreachable");
    let endpoint = format!("127.0.0.1:{}", free_port());
    let error = publish_with_sources(
        &endpoint,
        &scratch.0.join("packages"),
        new_scene(
            "demo",
            "Demo",
            gx_contracts::color::WorkingColorSpace::NEW_PROJECT,
        ),
        &[],
    )
    .expect_err("an unreachable plane cannot publish");
    assert!(
        matches!(error, EditorError::Unreachable { .. }),
        "expected Unreachable, got {error:?}"
    );
}

/// A scene that declares a font publishes through the Editor's own path to a
/// co-located engine: by path, with no asset bytes crossing the asset plane.
#[test]
fn a_scene_with_a_font_publishes_by_path_to_a_co_located_engine() {
    let Some(binary) = worker_binary() else {
        eprintln!("SKIP: gx-render-worker binary not built");
        return;
    };
    let scratch = Scratch::new("font-by-path");
    let folder = scratch.0.join("packages");
    std::fs::create_dir_all(&folder).unwrap();
    let asset = free_port();
    let Some(_worker) = start_worker(&binary, &scratch.0, asset, &package_dir_args(&folder)) else {
        eprintln!("SKIP: the worker did not come up");
        return;
    };
    let (scene, _, store) = lower_third("shell-with-font", &scratch.0);
    let sources = package_sources(&scene, &store).expect("the store holds the font");
    assert_eq!(sources.len(), 1, "the scene declares one asset");
    let published = publish_with_sources(&format!("127.0.0.1:{asset}"), &folder, scene, &sources)
        .expect("with its font the scene publishes");
    assert_eq!(published.take_id.0, "shell-with-font");
    assert_eq!(published.revision.0, 1);
    assert_eq!(published.handoff, AssetHandoff::LocalPath);
    assert_eq!(
        published.transferred_bytes, 0,
        "no asset byte crosses the plane by path"
    );
    assert!(packages_in(&folder).is_empty());
}

/// The same Editor, the same call, a different engine: one declared as LAN is
/// sent only the bytes it lacks, chunked. Nothing in the Editor changed.
#[test]
fn the_same_scene_goes_chunked_to_an_engine_that_declares_itself_lan() {
    let Some(binary) = worker_binary() else {
        eprintln!("SKIP: gx-render-worker binary not built");
        return;
    };
    let scratch = Scratch::new("font-lan");
    let folder = scratch.0.join("packages");
    let asset = free_port();
    let Some(_worker) = start_worker(&binary, &scratch.0, asset, &["--lan".to_owned()]) else {
        eprintln!("SKIP: the worker did not come up");
        return;
    };
    let (scene, font_len, store) = lower_third("shell-lan-font", &scratch.0);
    let sources = package_sources(&scene, &store).expect("the store holds the font");
    let endpoint = format!("127.0.0.1:{asset}");
    let published = publish_with_sources(&endpoint, &folder, scene.clone(), &sources)
        .expect("a LAN engine takes the chunked upload");
    assert_eq!(published.handoff, AssetHandoff::ChunkedUpload);
    assert_eq!(published.transferred_bytes, font_len as u64);
    // The engine now holds the font: publishing again sends nothing.
    let again = publish_with_sources(&endpoint, &folder, scene, &sources).unwrap();
    assert_eq!(again.revision.0, 2);
    assert_eq!(again.transferred_bytes, 0);
    assert!(packages_in(&folder).is_empty());
}

/// A co-located engine started without a package directory refuses by name,
/// and the Editor says where it writes. There is no fallback to the chunked
/// route: falling back would be probing and a silent substitution
/// (invariant 18).
#[test]
fn a_co_located_engine_without_a_package_directory_is_refused_by_name_with_no_fallback() {
    let Some(binary) = worker_binary() else {
        eprintln!("SKIP: gx-render-worker binary not built");
        return;
    };
    let scratch = Scratch::new("no-dir");
    let folder = scratch.0.join("packages");
    let asset = free_port();
    let Some(_worker) = start_worker(&binary, &scratch.0, asset, &[]) else {
        eprintln!("SKIP: the worker did not come up");
        return;
    };
    let error = publish_with_sources(
        &format!("127.0.0.1:{asset}"),
        &folder,
        new_scene(
            "no-dir",
            "No dir",
            gx_contracts::color::WorkingColorSpace::NEW_PROJECT,
        ),
        &[],
    )
    .expect_err("the engine reads no path");
    match &error {
        EditorError::PublishRefused { detail } => {
            assert!(detail.contains("no package directory"), "{detail}");
            assert!(detail.contains(&folder.display().to_string()), "{detail}");
        }
        other => panic!("expected PublishRefused, got {other:?}"),
    }
    assert!(packages_in(&folder).is_empty());
}

/// A package folder the engine was not started with is outside its directory.
#[test]
fn a_package_folder_the_engine_was_not_started_with_is_refused_by_name() {
    let Some(binary) = worker_binary() else {
        eprintln!("SKIP: gx-render-worker binary not built");
        return;
    };
    let scratch = Scratch::new("other-dir");
    let engines = scratch.0.join("engines");
    let editors = scratch.0.join("editors");
    std::fs::create_dir_all(&engines).unwrap();
    let asset = free_port();
    let Some(_worker) = start_worker(&binary, &scratch.0, asset, &package_dir_args(&engines))
    else {
        eprintln!("SKIP: the worker did not come up");
        return;
    };
    let error = publish_with_sources(
        &format!("127.0.0.1:{asset}"),
        &editors,
        new_scene(
            "other-dir",
            "Other dir",
            gx_contracts::color::WorkingColorSpace::NEW_PROJECT,
        ),
        &[],
    )
    .expect_err("the package is outside the engine's directory");
    match &error {
        EditorError::PublishRefused { detail } => {
            assert!(detail.contains("outside"), "{detail}");
            assert!(detail.contains(&editors.display().to_string()), "{detail}");
        }
        other => panic!("expected PublishRefused, got {other:?}"),
    }
    assert!(packages_in(&editors).is_empty());
}
