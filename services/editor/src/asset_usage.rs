//! Project-wide asset usage over a project store (Panchayati task 119, plan row 11.122).
//!
//! The rule is `gx_contracts::asset_usage` (one implementation, invariant 27: the Editor's tests read the same fixture). This reads what
//! the rule needs from a project: its library of assets, and every stored scene in the order the store lists them (sorted by scene id).
//! A scene that cannot be read is not skipped: it is named in the answer with the reason, so a missing scene is never mistaken for an
//! unused asset.

use gx_contracts::asset_usage::{project_asset_usage as usage_of, AssetUsageReport};

use crate::project::{EditorError, Projects};

/// The usage of every asset the project's library or any of its stored scenes declares.
///
/// Errors only when the project itself cannot be read (it does not exist, or its library cannot be listed): a refusal by name, as every
/// other read of the project is. A single scene that cannot be read is a `problem` in the report, not an error.
pub fn project_asset_usage(
    projects: &Projects,
    project: &str,
) -> Result<AssetUsageReport, EditorError> {
    let assets = projects.project_assets(project)?;
    let scenes = projects
        .list_scenes(project)?
        .into_iter()
        .map(|scene_id| {
            let read = projects
                .read_scene(project, &scene_id)
                .map_err(|error| error.to_string());
            (scene_id, read)
        })
        .collect();
    Ok(usage_of(&assets, scenes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::asset_usage::{SceneUse, UsageProblem};
    use gx_contracts::color::WorkingColorSpace;
    use gx_contracts::scene::{new_scene, AssetLibraryItem, SceneDocument, SceneObject};
    use serde_json::json;

    const HASH: &str = "abababababababababababababababababababababababababababababababab";
    const OTHER: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

    fn scratch(label: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "gx-asset-usage-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn asset(id: &str, checksum: &str) -> AssetLibraryItem {
        serde_json::from_value(json!({ "assetId": id, "name": id, "kind": "image", "path": format!("Assets/Images/{id}.png"), "checksum": checksum }))
            .unwrap()
    }

    fn image(id: &str, asset_id: &str) -> SceneObject {
        serde_json::from_value(
            json!({ "type": "image", "id": id, "name": id, "assetId": asset_id }),
        )
        .unwrap()
    }

    /// A scene declaring one asset and drawing it with `drawn` image objects.
    fn scene(id: &str, name: &str, asset_id: &str, checksum: &str, drawn: usize) -> SceneDocument {
        // The project's working space: a scene of another space is refused when written.
        let mut document = new_scene(id, name, WorkingColorSpace::Srgb);
        document.assets = vec![asset(asset_id, checksum)];
        document.objects = (0..drawn)
            .map(|n| image(&format!("img{n}"), asset_id))
            .collect();
        document
    }

    fn scene_ids(scenes: &[SceneUse]) -> Vec<&str> {
        scenes.iter().map(|scene| scene.scene_id.as_str()).collect()
    }

    #[test]
    fn a_project_is_read_scene_by_scene_in_the_stores_order_and_a_file_in_two_scenes_is_one_entry()
    {
        let root = scratch("order");
        let projects = Projects::at_root(root.join("store"));
        projects.create_project("show").unwrap();
        // Written out of order on purpose: the store lists scenes sorted by id.
        projects
            .write_scene("show", &scene("bravo", "Bravo", "logo-b", HASH, 2))
            .unwrap();
        projects
            .write_scene("show", &scene("alpha", "Alpha", "logo-a", HASH, 1))
            .unwrap();
        projects
            .write_scene("show", &scene("charlie", "Charlie", "unused", OTHER, 0))
            .unwrap();

        let report = project_asset_usage(&projects, "show").unwrap();
        let logo = report
            .entries
            .iter()
            .find(|entry| entry.key == HASH)
            .expect("the shared file");
        assert_eq!(
            scene_ids(&logo.scenes),
            ["alpha", "bravo"],
            "stored order, once each"
        );
        assert_eq!(
            logo.scenes[0],
            SceneUse {
                scene_id: "alpha".into(),
                name: "Alpha".into()
            }
        );
        assert_eq!(logo.asset_ids, ["logo-a", "logo-b"]);
        let unused = report
            .entries
            .iter()
            .find(|entry| entry.key == OTHER)
            .expect("the declared and undrawn asset");
        assert!(
            unused.scenes.is_empty(),
            "declared, drawn by nothing: an empty list"
        );
        assert_eq!(report.problems, []);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn an_asset_in_the_projects_library_that_no_scene_declares_is_reported_unused() {
        let root = scratch("library");
        let projects = Projects::at_root(root.join("store"));
        projects.create_project("show").unwrap();
        // A library record on disk, as the Editor files one (`Sources/<id>.json`), and one scene that uses a different file.
        let record = asset("lib-only", OTHER);
        std::fs::create_dir_all(root.join("store/show/Sources")).unwrap();
        std::fs::write(
            root.join("store/show/Sources/lib-only.json"),
            serde_json::to_vec_pretty(&record).unwrap(),
        )
        .unwrap();
        projects
            .write_scene("show", &scene("alpha", "Alpha", "logo", HASH, 1))
            .unwrap();

        let report = project_asset_usage(&projects, "show").unwrap();
        let spare = report
            .entries
            .iter()
            .find(|entry| entry.key == OTHER)
            .expect("the library asset is in the report");
        assert_eq!(spare.asset_ids, ["lib-only"]);
        assert!(
            spare.scenes.is_empty(),
            "nothing uses it: an empty list, not a missing entry"
        );
        assert_eq!(
            scene_ids(
                &report
                    .entries
                    .iter()
                    .find(|entry| entry.key == HASH)
                    .unwrap()
                    .scenes
            ),
            ["alpha"]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_scene_that_cannot_be_read_is_named_with_its_reason_and_the_rest_are_still_counted() {
        let root = scratch("broken");
        let projects = Projects::at_root(root.join("store"));
        projects.create_project("show").unwrap();
        projects
            .write_scene("show", &scene("alpha", "Alpha", "logo", HASH, 1))
            .unwrap();
        projects
            .write_scene("show", &scene("zulu", "Zulu", "logo", HASH, 1))
            .unwrap();
        std::fs::write(
            root.join("store/show/scenes/middle.json"),
            b"{ this is not a scene",
        )
        .unwrap();

        let report = project_asset_usage(&projects, "show").unwrap();
        assert_eq!(report.problems.len(), 1, "{:?}", report.problems);
        let UsageProblem { scene_id, reason } = &report.problems[0];
        assert_eq!(scene_id, "middle");
        assert!(!reason.is_empty(), "the reason is said");
        let logo = report
            .entries
            .iter()
            .find(|entry| entry.key == HASH)
            .unwrap();
        assert_eq!(
            scene_ids(&logo.scenes),
            ["alpha", "zulu"],
            "the readable scenes still count"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// The rule on documents nobody tidied. By hand, against a COPY of a real project (this only reads, but a copy costs nothing):
    /// `GX_REAL_PROJECTS=<store root> GX_REAL_PROJECT=<name> cargo test -p gx-editor --lib a_real_project -- --ignored --nocapture`.
    #[test]
    #[ignore = "reads a real project store named by GX_REAL_PROJECTS and GX_REAL_PROJECT; run by hand"]
    fn a_real_project_gives_a_report_that_agrees_with_its_own_scene_list() {
        let (Ok(root), Ok(project)) = (
            std::env::var("GX_REAL_PROJECTS"),
            std::env::var("GX_REAL_PROJECT"),
        ) else {
            panic!(
                "set GX_REAL_PROJECTS (the store root) and GX_REAL_PROJECT (a project name in it)"
            );
        };
        let projects = Projects::at_root(root);
        let report = project_asset_usage(&projects, &project).expect("the project reads");
        let listed = projects.list_scenes(&project).expect("the scene list");
        let used: usize = report
            .entries
            .iter()
            .filter(|entry| !entry.scenes.is_empty())
            .count();
        println!(
            "{project}: {} scenes listed, {} assets ({used} used, {} unused), {} scenes that could not be read: {:?}",
            listed.len(),
            report.entries.len(),
            report.entries.len() - used,
            report.problems.len(),
            report.problems
        );
        for entry in &report.entries {
            println!(
                "  {} ids {:?} -> {:?}",
                &entry.key[..entry.key.len().min(14)],
                entry.asset_ids,
                entry
                    .scenes
                    .iter()
                    .map(|scene| scene.scene_id.as_str())
                    .collect::<Vec<_>>()
            );
            let positions: Vec<usize> = entry
                .scenes
                .iter()
                .map(|scene| {
                    listed
                        .iter()
                        .position(|id| *id == scene.scene_id)
                        .expect("a scene the store lists")
                })
                .collect();
            assert!(
                positions.windows(2).all(|pair| pair[0] < pair[1]),
                "stored order, once each: {positions:?}"
            );
        }
        for problem in &report.problems {
            assert!(
                listed.contains(&problem.scene_id),
                "a problem names a listed scene"
            );
        }
    }

    #[test]
    fn a_project_with_no_scenes_has_an_empty_report_and_a_missing_project_is_refused_by_name() {
        let root = scratch("empty");
        let projects = Projects::at_root(root.join("store"));
        projects.create_project("show").unwrap();
        assert_eq!(
            project_asset_usage(&projects, "show").unwrap(),
            AssetUsageReport::default()
        );
        assert!(matches!(
            project_asset_usage(&projects, "nothing"),
            Err(EditorError::Refused(_))
        ));
        let _ = std::fs::remove_dir_all(root);
    }
}
