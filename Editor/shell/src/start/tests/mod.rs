use super::*;
use gx_contracts::command::{CreateScene, EditorCommand};

fn scratch(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("gx-start-{label}-{nanos}"));
    std::fs::create_dir_all(&path).expect("scratch directory");
    path
}

struct Harness {
    root: PathBuf,
    workspace: Workspace,
    cell: OpenProjectCell,
    recent: RecentProjects,
}

fn harness(label: &str) -> Harness {
    let root = scratch(label);
    Harness {
        recent: RecentProjects::at(root.join("prefs").join("recent.json")),
        workspace: Workspace::new(None),
        cell: OpenProjectCell::default(),
        root,
    }
}

fn is_refused<T: std::fmt::Debug>(result: Result<T, StartError>, name: &str) -> bool {
    match result {
        Err(StartError::Command(CommandError::Refused(cause))) => {
            format!("{cause:?}").contains(name)
        }
        Err(StartError::Store(StoreError::Refused(cause))) => format!("{cause:?}").contains(name),
        _ => false,
    }
}

#[test]
fn nothing_can_be_stored_until_a_project_is_created_somewhere_chosen() {
    let mut h = harness("none");
    assert!(!h.workspace.has_project());
    assert_eq!(h.cell.get(), None);
    assert!(h.cell.projects().is_none());
    // A scene cannot be created with no project open.
    let created = h.workspace.execute(EditorCommand::CreateScene(CreateScene {
        project: "Finals".into(),
        scene_id: "a".into(),
        name: "A".into(),
    }));
    assert!(created.is_err(), "no project, no work");

    let chosen = h.root.join("My Shows");
    std::fs::create_dir_all(&chosen).unwrap();
    let opened = new_project(&mut h.workspace, &h.cell, &h.recent, &chosen, "Finals", 10).unwrap();
    assert_eq!(opened.name, "Finals");
    assert!(
        Path::new(&opened.gpx).is_file(),
        "the named .gpx is on disk"
    );
    assert_eq!(Path::new(&opened.root), chosen);
    assert!(h.workspace.has_project());
    assert_eq!(h.cell.get().unwrap().name, "Finals");

    h.workspace
        .execute(EditorCommand::CreateScene(CreateScene {
            project: "Finals".into(),
            scene_id: "a".into(),
            name: "A".into(),
        }))
        .expect("with a project open the work can start");
    assert!(chosen
        .join("Finals")
        .join("scenes")
        .join("a.json")
        .is_file());
    std::fs::remove_dir_all(h.root).expect("clean up");
}

#[test]
fn a_new_project_refuses_a_missing_folder_and_an_existing_project_and_creates_nothing() {
    let mut h = harness("new-refusals");
    let chosen = h.root.join("shows");
    std::fs::create_dir_all(&chosen).unwrap();
    new_project(&mut h.workspace, &h.cell, &h.recent, &chosen, "Finals", 1).unwrap();
    assert!(is_refused(
        new_project(&mut h.workspace, &h.cell, &h.recent, &chosen, "Finals", 2),
        "ProjectAlreadyExists"
    ));
    assert!(is_refused(
        new_project(
            &mut h.workspace,
            &h.cell,
            &h.recent,
            &h.root.join("nowhere"),
            "X",
            3
        ),
        "PlatformDirectoryUnavailable"
    ));
    assert!(!h.root.join("nowhere").exists());
    assert!(is_refused(
        new_project(&mut h.workspace, &h.cell, &h.recent, &chosen, "a/b", 4),
        "ProjectNameInvalid"
    ));
    assert_eq!(
        h.cell.get().unwrap().name,
        "Finals",
        "a refused New leaves the open project open"
    );
    std::fs::remove_dir_all(h.root).expect("clean up");
}

#[test]
fn a_project_opens_from_its_gpx_and_a_scene_with_unsaved_changes_blocks_the_switch() {
    let mut h = harness("switch");
    let chosen = h.root.join("shows");
    std::fs::create_dir_all(&chosen).unwrap();
    let a = new_project(&mut h.workspace, &h.cell, &h.recent, &chosen, "A", 1).unwrap();
    let b = new_project(&mut h.workspace, &h.cell, &h.recent, &chosen, "B", 2).unwrap();
    assert_eq!(h.cell.get().unwrap().name, "B");

    let reopened =
        open_project(&mut h.workspace, &h.cell, &h.recent, Path::new(&a.gpx), 3).unwrap();
    assert_eq!(reopened.name, "A");
    assert_eq!(h.cell.get().unwrap().name, "A");

    // Open a scene in A and change it: switching to B must refuse, create and open nothing.
    use gx_contracts::command::{OpenScene, SceneSource};
    h.workspace
        .execute(EditorCommand::OpenScene(OpenScene {
            source: SceneSource::New {
                id: "s".into(),
                name: "S".into(),
            },
        }))
        .unwrap();
    let key = SessionKey(1);
    // A fresh unbound scene is not dirty; make one dirty with an edit.
    use gx_contracts::command::{EditScene, SceneEdit, SceneTarget};
    h.workspace
        .execute(EditorCommand::EditScene(EditScene {
            target: SceneTarget::Session { session: key },
            edits: vec![SceneEdit::CreateObject(
                gx_contracts::command::CreateObject {
                    kind: "rect".into(),
                    name: "R".into(),
                },
            )],
            module: Default::default(),
            if_revision: None,
        }))
        .expect("the edit applies");
    let before = std::fs::read_dir(&chosen).unwrap().count();
    let blocked = open_project(&mut h.workspace, &h.cell, &h.recent, Path::new(&b.gpx), 4);
    assert!(
        h.workspace.view(key).expect("open").dirty,
        "the edit left the scene with unsaved changes"
    );
    assert!(is_refused(blocked, "SessionHasUnsavedChanges"));
    assert_eq!(h.cell.get().unwrap().name, "A", "nothing switched");
    let blocked_new = new_project(&mut h.workspace, &h.cell, &h.recent, &chosen, "C", 5);
    assert!(is_refused(blocked_new, "SessionHasUnsavedChanges"));
    assert_eq!(
        std::fs::read_dir(&chosen).unwrap().count(),
        before,
        "a refused switch leaves no new project behind"
    );
    std::fs::remove_dir_all(h.root).expect("clean up");
}

#[test]
fn closing_leaves_none_open_and_the_recent_list_remembers_each_in_order() {
    let mut h = harness("recent");
    let chosen = h.root.join("shows");
    std::fs::create_dir_all(&chosen).unwrap();
    new_project(&mut h.workspace, &h.cell, &h.recent, &chosen, "A", 1).unwrap();
    new_project(&mut h.workspace, &h.cell, &h.recent, &chosen, "B", 2).unwrap();
    let names: Vec<_> = list_recent(&h.recent)
        .into_iter()
        .map(|r| r.project.name)
        .collect();
    assert_eq!(names, ["B", "A"]);
    assert!(list_recent(&h.recent).iter().all(|r| r.exists));

    close_project(&mut h.workspace, &h.cell).unwrap();
    assert!(!h.workspace.has_project());
    assert_eq!(h.cell.get(), None);

    // A project that is moved away shows as missing, and is still listed to be forgotten.
    std::fs::remove_dir_all(chosen.join("A")).unwrap();
    let listed = list_recent(&h.recent);
    let a = listed.iter().find(|r| r.project.name == "A").unwrap();
    assert!(!a.exists);
    assert!(
        listed
            .iter()
            .find(|r| r.project.name == "B")
            .unwrap()
            .exists
    );
    std::fs::remove_dir_all(h.root).expect("clean up");
}

#[test]
fn a_folder_made_before_the_gpx_opens_and_a_failed_recent_write_does_not_stop_it() {
    let mut h = harness("legacy");
    let folder = h.root.join("shows").join("old");
    std::fs::create_dir_all(folder.join("scenes")).unwrap();
    // The recent list cannot be written: its parent is a file.
    let blocker = h.root.join("blocker");
    std::fs::write(&blocker, b"x").unwrap();
    h.recent = RecentProjects::at(blocker.join("recent.json"));
    let opened = open_folder(&mut h.workspace, &h.cell, &h.recent, &folder, 1).unwrap();
    assert_eq!(opened.name, "old");
    // A folder with no settings is what the engine rendered before depth and the working space
    // were written down: linear light at 32-bit float. The page is told so.
    assert_eq!(
        opened.working_color_space,
        gx_contracts::color::WorkingColorSpace::LinearSrgb
    );
    assert_eq!(opened.color_depth, gx_contracts::color::ColorDepth::Bits32);
    assert!(folder.join("old.gpx").is_file(), "upgraded on the way in");
    assert!(h.workspace.has_project());
    assert_eq!(
        discover(&h.root.join("shows")),
        vec![("old".to_owned(), folder)]
    );
    std::fs::remove_dir_all(h.root).expect("clean up");
}

/// Open the stored scene `a` of `project` and leave it with one unsaved edit; returns its key.
fn open_and_change(h: &mut Harness, project: &str) -> SessionKey {
    use gx_contracts::command::{
        CreateObject, EditScene, OpenScene, SceneEdit, SceneSource, SceneTarget,
    };
    let opened = h
        .workspace
        .execute(EditorCommand::OpenScene(OpenScene {
            source: SceneSource::Project {
                project: project.into(),
                scene_id: "a".into(),
            },
        }))
        .expect("the stored scene opens");
    let key = opened.session.expect("a session").session;
    h.workspace
        .execute(EditorCommand::EditScene(EditScene {
            target: SceneTarget::Session { session: key },
            edits: vec![SceneEdit::CreateObject(CreateObject {
                kind: "rect".into(),
                name: "Unsaved".into(),
            })],
            module: Default::default(),
            if_revision: None,
        }))
        .expect("the edit applies");
    assert!(h.workspace.view(key).expect("open").dirty);
    key
}

fn folder_entries(folder: &Path) -> Vec<String> {
    let mut names: Vec<_> = std::fs::read_dir(folder)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// A project with scene `a`, a picture, a font and a retained source, at 32 bit (not the default,
/// so a copy that fell back to the default would show).
fn finals(h: &mut Harness) -> PathBuf {
    use gx_contracts::color::ColorDepth;
    let chosen = h.root.join("Shows");
    std::fs::create_dir_all(&chosen).unwrap();
    let mut settings = ProjectSettings::new_project();
    settings.color_depth = ColorDepth::Bits32;
    new_project_with(
        &mut h.workspace,
        &h.cell,
        &h.recent,
        &chosen,
        "Finals",
        settings,
        1,
    )
    .unwrap();
    h.workspace
        .execute(EditorCommand::CreateScene(CreateScene {
            project: "Finals".into(),
            scene_id: "a".into(),
            name: "A".into(),
        }))
        .unwrap();
    let folder = chosen.join("Finals");
    std::fs::create_dir_all(folder.join("Assets").join("Images").join("frame")).unwrap();
    std::fs::write(
        folder
            .join("Assets")
            .join("Images")
            .join("frame")
            .join("pic.png"),
        b"picture bytes",
    )
    .unwrap();
    std::fs::write(folder.join("Fonts").join("Face.ttf"), b"font bytes").unwrap();
    std::fs::create_dir_all(folder.join("Sources")).unwrap();
    std::fs::write(
        folder.join("Sources").join("source.json"),
        b"{\"kept\":true}",
    )
    .unwrap();
    chosen
}

/// File > Save As: the copy is a whole project that carries the unsaved work, and the original
/// stays exactly as it was last saved.
#[test]
fn save_as_copies_the_whole_project_with_the_unsaved_work_and_leaves_the_original_alone() {
    let mut h = harness("save-as");
    let chosen = finals(&mut h);
    let original = chosen.join("Finals");
    let scene_before = std::fs::read(original.join("scenes").join("a.json")).unwrap();
    let document_before = std::fs::read(original.join("Finals.gpx")).unwrap();
    let key = open_and_change(&mut h, "Finals");

    let opened = save_project_as(
        &mut h.workspace,
        &h.cell,
        &h.recent,
        &chosen,
        "Finals v2",
        5,
    )
    .unwrap();

    assert_eq!(opened.name, "Finals v2");
    assert_eq!(Path::new(&opened.root), chosen);
    assert_eq!(
        opened.color_depth,
        gx_contracts::color::ColorDepth::Bits32,
        "the copy declares what the original declared"
    );
    assert_eq!(opened.closed_sessions, vec![key], "the open scene closed");
    assert!(h.workspace.view(key).is_err(), "no session is left open");
    assert_eq!(
        h.cell.get().unwrap().name,
        "Finals v2",
        "the copy is the open project"
    );

    // The original is byte for byte what it was: the unsaved work did not go into it.
    assert_eq!(
        std::fs::read(original.join("scenes").join("a.json")).unwrap(),
        scene_before
    );
    assert_eq!(
        std::fs::read(original.join("Finals.gpx")).unwrap(),
        document_before
    );

    // The copy is a project of its own: its document names it, and it opens from that file.
    let copy = chosen.join("Finals v2");
    let (_, reopened) = Projects::open_gpx(&copy.join("Finals v2.gpx")).unwrap();
    assert_eq!(reopened, "Finals v2");
    assert!(
        !copy.join("Finals.gpx").exists(),
        "the old name does not follow the copy"
    );
    assert!(
        !copy.join(".scenes.lock").exists(),
        "a lock is not part of a copy"
    );
    assert!(
        !chosen.join("Finals v2.saving").exists(),
        "the staging folder is gone"
    );
    for relative in [
        "Assets/Images/frame/pic.png",
        "Fonts/Face.ttf",
        "Sources/source.json",
    ] {
        assert_eq!(
            std::fs::read(copy.join(relative)).unwrap(),
            std::fs::read(original.join(relative)).unwrap(),
            "{relative} is copied byte for byte"
        );
    }

    // The unsaved object is in the copy's scene, saved there with the next revision.
    let projects = h.cell.projects().unwrap();
    let stored = projects.read_scene("Finals v2", "a").unwrap();
    let before = projects.read_scene("Finals", "a").unwrap();
    assert_eq!(before.objects.len(), 0, "the original never had the object");
    assert_eq!(
        stored.objects.len(),
        1,
        "the unsaved object moved to the copy"
    );
    assert!(
        stored.revision > before.revision,
        "{:?} {:?}",
        stored.revision,
        before.revision
    );

    // What the copy's own document declares (read from the file, not from what the page was told).
    let declared = projects.settings("Finals v2").unwrap();
    assert_eq!(
        declared.color_depth,
        gx_contracts::color::ColorDepth::Bits32
    );
    assert_eq!(
        declared.working_color_space,
        projects.settings("Finals").unwrap().working_color_space
    );

    let names: Vec<_> = list_recent(&h.recent)
        .into_iter()
        .map(|r| r.project.name)
        .collect();
    assert_eq!(
        names,
        ["Finals v2", "Finals"],
        "the copy is the newest recent"
    );
    std::fs::remove_dir_all(h.root).expect("clean up");
}

/// A blank scene is born in what the open project declares. Found in the real window: in a 32 bit
/// project the first "Save to project" of the startup scene was refused, because it was born at the
/// default 16 bit.
#[test]
fn a_new_scene_is_born_in_the_open_projects_depth_and_saves_into_it() {
    use gx_contracts::color::ColorDepth;
    use gx_contracts::command::{OpenScene, SaveScene, SaveTarget, SceneSource};
    let new_blank = |h: &mut Harness, id: &str| -> SessionKey {
        h.workspace
            .execute(EditorCommand::OpenScene(OpenScene {
                source: SceneSource::New {
                    id: id.into(),
                    name: id.into(),
                },
            }))
            .unwrap()
            .session
            .unwrap()
            .session
    };
    let mut h = harness("born-in-project");
    let chosen = finals(&mut h); // a 32 bit project
    let key = new_blank(&mut h, "blank");
    assert_eq!(
        h.workspace.view(key).unwrap().document.color_depth,
        ColorDepth::Bits32,
        "the blank scene takes the project's depth"
    );
    h.workspace
        .execute(EditorCommand::SaveScene(SaveScene {
            session: key,
            to: SaveTarget::Project {
                project: "Finals".into(),
            },
        }))
        .expect("a scene born in the project saves into it");
    assert!(chosen
        .join("Finals")
        .join("scenes")
        .join("blank.json")
        .is_file());

    // An imported SVG takes the project's depth too (as a stored import does).
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><rect width="40" height="20" fill="#ff0000"/></svg>"##;
    let imported = h
        .workspace
        .execute(EditorCommand::OpenScene(OpenScene {
            source: SceneSource::ImportSvg {
                id: "imported".into(),
                source_name: "red.svg".into(),
                svg: svg.into(),
            },
        }))
        .expect("the SVG imports")
        .session
        .unwrap();
    assert_eq!(imported.document.color_depth, ColorDepth::Bits32);

    // A copy declares the same, so scenes made there are born in it too.
    save_project_as(&mut h.workspace, &h.cell, &h.recent, &chosen, "Copy", 3).unwrap();
    let key = new_blank(&mut h, "after-copy");
    assert_eq!(
        h.workspace.view(key).unwrap().document.color_depth,
        ColorDepth::Bits32
    );

    // With the project closed, nothing carries over: the new-project default again.
    h.workspace
        .execute(EditorCommand::CloseScene(
            gx_contracts::command::CloseScene {
                session: key,
                force: true,
            },
        ))
        .unwrap();
    close_project(&mut h.workspace, &h.cell).unwrap();
    let key = new_blank(&mut h, "none");
    assert_eq!(
        h.workspace.view(key).unwrap().document.color_depth,
        ColorDepth::Bits16
    );
    std::fs::remove_dir_all(h.root).expect("clean up");
}

/// File > Exit refuses by name while a scene has unsaved work, and allows it once nothing is unsaved.
#[test]
fn exit_is_refused_while_a_scene_has_unsaved_work() {
    let mut h = harness("exit");
    finals(&mut h);
    require_can_exit(&h.workspace).expect("nothing unsaved: Exit is allowed");
    let key = open_and_change(&mut h, "Finals");
    assert!(is_refused(
        require_can_exit(&h.workspace),
        "SessionHasUnsavedChanges"
    ));
    h.workspace
        .execute(EditorCommand::CloseScene(
            gx_contracts::command::CloseScene {
                session: key,
                force: true,
            },
        ))
        .unwrap();
    require_can_exit(&h.workspace).expect("the scene was closed: Exit is allowed");
    std::fs::remove_dir_all(h.root).expect("clean up");
}

/// A copy saved in another folder is where work goes next: the workspace moved its store.
#[test]
fn work_after_save_as_into_another_folder_lands_in_the_copy() {
    let mut h = harness("save-as-elsewhere");
    let chosen = finals(&mut h);
    let elsewhere = h.root.join("Elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let opened =
        save_project_as(&mut h.workspace, &h.cell, &h.recent, &elsewhere, "Copy", 2).unwrap();
    assert_eq!(Path::new(&opened.root), elsewhere);
    assert!(elsewhere.join("Copy").join("Copy.gpx").is_file());
    assert!(
        elsewhere
            .join("Copy")
            .join("scenes")
            .join("a.json")
            .is_file(),
        "the stored scene came along"
    );
    h.workspace
        .execute(EditorCommand::CreateScene(CreateScene {
            project: "Copy".into(),
            scene_id: "b".into(),
            name: "B".into(),
        }))
        .expect("the workspace now stores in the copy's folder");
    assert!(elsewhere
        .join("Copy")
        .join("scenes")
        .join("b.json")
        .is_file());
    assert!(
        !chosen.join("Finals").join("scenes").join("b.json").exists(),
        "and nothing went into the original"
    );
    std::fs::remove_dir_all(h.root).expect("clean up");
}

/// Everything Save As refuses, by name, and each leaves the project open and nothing behind.
#[test]
fn save_as_refuses_by_name_and_leaves_nothing_behind() {
    let mut h = harness("save-as-refusals");
    // With no project open there is nothing to copy.
    assert!(is_refused(
        save_project_as(&mut h.workspace, &h.cell, &h.recent, &h.root, "X", 1),
        "ProjectNotFound"
    ));

    let chosen = finals(&mut h);
    let original = chosen.join("Finals");
    let before = folder_entries(&chosen);

    // A name that is already a project (the project itself, or another), never overwritten.
    assert!(is_refused(
        save_project_as(&mut h.workspace, &h.cell, &h.recent, &chosen, "Finals", 2),
        "ProjectAlreadyExists"
    ));
    // A bad name and a folder that is not there.
    assert!(is_refused(
        save_project_as(&mut h.workspace, &h.cell, &h.recent, &chosen, "a/b", 3),
        "ProjectNameInvalid"
    ));
    assert!(is_refused(
        save_project_as(
            &mut h.workspace,
            &h.cell,
            &h.recent,
            &h.root.join("nowhere"),
            "X",
            4
        ),
        "PlatformDirectoryUnavailable"
    ));
    // A folder inside the project being copied would copy itself without end.
    let inside = original.join("scenes");
    assert!(is_refused(
        save_project_as(&mut h.workspace, &h.cell, &h.recent, &inside, "Inner", 5),
        "PlatformDirectoryUnavailable"
    ));
    assert!(!inside.join("Inner").exists());
    assert_eq!(folder_entries(&chosen), before);

    // A failure part-way removes what it made: a folder in the project that takes the name of
    // the copy's document cannot be overwritten by it.
    std::fs::create_dir_all(original.join("Doc v2.gpx")).unwrap();
    assert!(save_project_as(&mut h.workspace, &h.cell, &h.recent, &chosen, "Doc v2", 6).is_err());
    assert_eq!(folder_entries(&chosen), before, "no half-made copy is left");
    std::fs::remove_dir(original.join("Doc v2.gpx")).unwrap();

    // A scene with unsaved work that is not stored in this project would be lost by the switch.
    use gx_contracts::command::{
        CreateObject, EditScene, OpenScene, SceneEdit, SceneSource, SceneTarget,
    };
    let opened = h
        .workspace
        .execute(EditorCommand::OpenScene(OpenScene {
            source: SceneSource::New {
                id: "loose".into(),
                name: "Loose".into(),
            },
        }))
        .unwrap();
    let loose = opened.session.unwrap().session;
    h.workspace
        .execute(EditorCommand::EditScene(EditScene {
            target: SceneTarget::Session { session: loose },
            edits: vec![SceneEdit::CreateObject(CreateObject {
                kind: "rect".into(),
                name: "R".into(),
            })],
            module: Default::default(),
            if_revision: None,
        }))
        .unwrap();
    assert!(is_refused(
        save_project_as(&mut h.workspace, &h.cell, &h.recent, &chosen, "Copy", 7),
        "SessionHasUnsavedChanges"
    ));
    assert_eq!(folder_entries(&chosen), before);
    assert_eq!(h.cell.get().unwrap().name, "Finals");
    assert!(
        h.workspace.view(loose).unwrap().dirty,
        "the work is still there"
    );
    h.workspace
        .execute(EditorCommand::CloseScene(
            gx_contracts::command::CloseScene {
                session: loose,
                force: true,
            },
        ))
        .unwrap();

    // A scene whose stored copy moved on since it was read is not overwritten in the copy.
    let key = open_and_change(&mut h, "Finals");
    let projects = h.cell.projects().unwrap();
    let mut moved = projects.read_scene("Finals", "a").unwrap();
    moved.revision = Some(gx_contracts::Revision(9));
    projects.write_scene("Finals", &moved).unwrap();
    assert!(is_refused(
        save_project_as(&mut h.workspace, &h.cell, &h.recent, &chosen, "Copy", 8),
        "RevisionMismatch"
    ));
    assert_eq!(folder_entries(&chosen), before);
    assert!(
        h.workspace.view(key).unwrap().dirty,
        "a refused Save As keeps the scene and its unsaved work"
    );
    assert_eq!(h.cell.get().unwrap().name, "Finals");
    std::fs::remove_dir_all(h.root).expect("clean up");
}

#[test]
fn a_project_is_created_at_the_colour_depth_the_dialog_chose() {
    use gx_contracts::color::ColorDepth;
    use gx_contracts::project::ProjectSettings;
    let chosen_parent = |h: &Harness| {
        let chosen = h.root.join("Shows");
        std::fs::create_dir_all(&chosen).unwrap();
        chosen
    };
    for depth in [ColorDepth::Bits8, ColorDepth::Bits16, ColorDepth::Bits32] {
        let mut h = harness(&format!("depth-{}", depth.as_str()));
        let chosen = chosen_parent(&h);
        let mut settings = ProjectSettings::new_project();
        settings.color_depth = depth;
        let name = format!("Depth {}", depth.as_str());
        let opened = new_project_with(
            &mut h.workspace,
            &h.cell,
            &h.recent,
            &chosen,
            &name,
            settings,
            1,
        )
        .unwrap();
        // The page is told what the dialog chose, from the project's own settings.
        assert_eq!(opened.color_depth, depth);
        assert_eq!(
            opened.working_color_space,
            gx_contracts::color::WorkingColorSpace::Srgb
        );
        let projects = h.cell.projects().unwrap();
        assert_eq!(projects.settings(&name).unwrap().color_depth, depth);
        // The file says it, and a scene made in the project carries it.
        let file = std::fs::read_to_string(chosen.join(&name).join(format!("{name}.gpx"))).unwrap();
        assert!(
            file.contains(&format!("\"colorDepth\": \"{}\"", depth.as_str()))
                || file.contains(&format!("\"colorDepth\":\"{}\"", depth.as_str())),
            "{file}"
        );
        h.workspace
            .execute(EditorCommand::CreateScene(CreateScene {
                project: name.clone(),
                scene_id: "a".into(),
                name: "A".into(),
            }))
            .unwrap();
        assert_eq!(projects.read_scene(&name, "a").unwrap().color_depth, depth);
        std::fs::remove_dir_all(h.root).expect("clean up");
    }
    // The plain New Project (no choice) is 16 bit.
    let mut h = harness("depth-default");
    let chosen = chosen_parent(&h);
    new_project(&mut h.workspace, &h.cell, &h.recent, &chosen, "Plain", 1).unwrap();
    assert_eq!(
        h.cell
            .projects()
            .unwrap()
            .settings("Plain")
            .unwrap()
            .color_depth,
        ColorDepth::Bits16
    );
    std::fs::remove_dir_all(h.root).expect("clean up");
}
