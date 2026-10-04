//! The 11.36 command refusals, driven through the surfaces that produce them.
//!
//! Every editor mutation is an `EditorCommand` (invariant 60), so each refusal
//! is driven through `parse_command` or `gx_editor::command::Workspace` — the
//! exact path the shell and MCP take — rather than by calling a rule function
//! a surface might not reach. A check also asserts that the refused command
//! left the document, history and store as they were.

use gx_contracts::animation::{SceneEasing, SceneKeyframe};
use gx_contracts::command::{
    parse_command, witness, AddAssets, AddFonts, ApplyPreset, CloseScene, CreateKeyframe, CreateObject,
    CreateProject, CreateScene, DeleteMaterial, DeleteScene, EditScene, EditorCommand,
    EditorModule, HistoryDirection, OpenScene, PresetPhase, RelinkMaterial, RemoveFont,
    ReplaceDataContext, SaveScene, SaveTakePage, SaveTarget, SceneEdit, SceneSource, SceneTarget,
    SessionKey, SetBinding, SetObjectField, SetObjectLocked, SetObjectVisible, SetSceneId,
    SetSceneName, Undo,
};
use gx_contracts::control::TakePage;
use gx_contracts::object_edit::ObjectField;
use gx_contracts::scene::{GroupObject, ImageObject, ObjectBase, RectObject, SceneDocument, SceneObject};
use gx_contracts::Refusal;
use gx_editor::command::{CommandError, Workspace};
use gx_editor::Projects;

use super::PLANE;
use crate::editor_commands::Scratch;
use crate::{expect, Outcome, Report};

const PROJECT: &str = "audit";
const STORED: &str = "stored";

/// The witness fixture plus the hierarchy, lock and image cases the object,
/// binding and material rules refuse on.
fn fixture() -> SceneDocument {
    let mut scene = witness::fixture_scene();
    let rect = |id: &str| {
        SceneObject::Rect(RectObject {
            base: ObjectBase::new(id, id),
            radius: 0.0,
        })
    };
    let group = |id: &str, child: &str| GroupObject {
        base: ObjectBase::new(id, id),
        child_ids: vec![child.to_owned()],
    };
    let mut hidden = group("hidden-group", "hidden-child");
    hidden.base.visible = false;
    let mut locking = group("locked-group", "locked-child");
    locking.base.locked = true;
    let mut own_lock = ObjectBase::new("own-lock", "own-lock");
    own_lock.locked = true;
    scene.objects.extend([
        SceneObject::Group(hidden),
        rect("hidden-child"),
        SceneObject::Group(locking),
        rect("locked-child"),
        SceneObject::Rect(RectObject {
            base: own_lock,
            radius: 0.0,
        }),
        SceneObject::Image(ImageObject {
            base: ObjectBase::new("logo", "Logo"),
            asset_id: "asset1".into(),
            fit: Default::default(),
        }),
    ]);
    scene.data_context.extend([
        ("title".to_owned(), serde_json::json!("Title")),
        ("tooOpaque".to_owned(), serde_json::json!(5.0)),
        ("absentAsset".to_owned(), serde_json::json!("no-such-asset")),
    ]);
    scene
}

fn refused(result: &Result<impl Sized, CommandError>) -> Option<&Refusal> {
    match result {
        Err(CommandError::Refused(refusal)) => Some(refusal),
        _ => None,
    }
}

/// Run one edit batch against a session, returning the refusal and whether
/// the session's document, history depth and dirty flag were left alone.
fn refuse_edit(workspace: &mut Workspace, session: SessionKey, edits: Vec<SceneEdit>) -> (Option<Refusal>, bool) {
    let before = workspace.view(session).ok();
    let result = workspace.execute(EditorCommand::EditScene(EditScene {
        target: SceneTarget::Session { session },
        edits,
        module: None,
    }));
    let after = workspace.view(session).ok();
    (refused(&result).cloned(), before.is_some() && before == after)
}

fn edit(workspace: &mut Workspace, session: SessionKey, edit: SceneEdit) -> (Option<Refusal>, bool) {
    refuse_edit(workspace, session, vec![edit])
}

fn set_binding(object: &str, property: &str, path: Option<&str>) -> SceneEdit {
    SceneEdit::SetBinding(SetBinding {
        object_id: object.into(),
        property: property.into(),
        path: path.map(str::to_owned),
    })
}

/// Whether anything named `stem` (any extension) exists anywhere under
/// `root`: a traversal refusal must have written nothing, wherever the
/// escaped path would have landed.
fn wrote_anything_named(root: &std::path::Path, stem: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(root) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        path.file_stem().is_some_and(|name| name == stem) || (path.is_dir() && wrote_anything_named(&path, stem))
    })
}

pub(super) fn drive_command_refusals(report: &mut Report) {
    // The shell's `cmd_execute` and every MCP write handler parse through
    // `parse_command`; a misspelt key must be refused with its path rather
    // than dropped, which would execute a different command than was sent.
    let parsed = parse_command(serde_json::json!({ "command": "undo", "session": 1, "sesion": 2 }));
    report.record(
        PLANE,
        "CommandUnknownField is produced for a command carrying an unknown key",
        expect(
            matches!(&parsed, Err(Refusal::CommandUnknownField { path }) if path == "sesion"),
            format!("expected CommandUnknownField at sesion, got {parsed:?}"),
        ),
    );

    let scratch = match Scratch::create("command-refusals") {
        Ok(scratch) => scratch,
        Err(error) => {
            report.record(
                PLANE,
                "command refusal fixture root is writable",
                Outcome::Fail(format!("cannot create the command refusal root: {error}")),
            );
            return;
        }
    };
    let scene = fixture();
    let fixture_path = scratch.path().join("refusals.gpx");
    let written = serde_json::to_vec(&scene)
        .map_err(|error| error.to_string())
        .and_then(|bytes| std::fs::write(&fixture_path, bytes).map_err(|error| error.to_string()));
    if let Err(error) = written {
        report.record(
            PLANE,
            "command refusal fixture root is writable",
            Outcome::Fail(format!("cannot write the command refusal fixture: {error}")),
        );
        return;
    }
    let mut workspace = Workspace::new(Some(Projects::at_root(scratch.path().join("Projects"))));
    let opened = workspace.execute(EditorCommand::OpenScene(OpenScene {
        source: SceneSource::File {
            path: fixture_path.display().to_string(),
        },
    }));
    let session = match opened.as_ref().map(|outcome| outcome.session.as_ref().map(|view| view.session)) {
        Ok(Some(session)) => session,
        other => {
            report.record(
                PLANE,
                "command refusal fixture opens as a session",
                Outcome::Fail(format!("the refusal fixture did not open: {other:?}")),
            );
            return;
        }
    };

    drive_session_refusals(report, &mut workspace, session);
    drive_object_refusals(report, &mut workspace, session, &scene);
    drive_binding_refusals(report, &mut workspace, session, &scene);
    drive_material_and_scene_refusals(report, &mut workspace, session);
    drive_store_refusals(report, &mut workspace, &scratch);
}

fn drive_session_refusals(report: &mut Report, workspace: &mut Workspace, session: SessionKey) {
    let absent = SessionKey(session.0 + 1000);
    let result = workspace.execute(EditorCommand::Undo(Undo { session: absent, module: None }));
    report.record(
        PLANE,
        "SessionUnknown is produced for a command naming no open session",
        expect(
            matches!(refused(&result), Some(Refusal::SessionUnknown { session: named }) if *named == absent),
            format!("expected SessionUnknown for {absent:?}, got {result:?}"),
        ),
    );

    let result = workspace.execute(EditorCommand::Undo(Undo { session, module: None }));
    report.record(
        PLANE,
        "HistoryEmpty is produced for an undo with nothing to undo",
        expect(
            matches!(
                refused(&result),
                Some(Refusal::HistoryEmpty { session: named, direction: HistoryDirection::Undo }) if *named == session
            ),
            format!("expected HistoryEmpty(undo) for {session:?}, got {result:?}"),
        ),
    );

    let result = workspace.execute(EditorCommand::Undo(Undo { session, module: Some(EditorModule::Timeline) }));
    report.record(
        PLANE,
        "ModuleHistoryEmpty is produced for a module undo with nothing from that module",
        expect(
            matches!(
                refused(&result),
                Some(Refusal::ModuleHistoryEmpty { module: EditorModule::Timeline, direction: HistoryDirection::Undo, .. })
            ),
            format!("expected ModuleHistoryEmpty(timeline) for {session:?}, got {result:?}"),
        ),
    );

    // A history where the timeline's key stands on the object manager's
    // rect, in its own session so the fixture session keeps its state.
    let conflict = match workspace.execute(EditorCommand::OpenScene(OpenScene {
        source: SceneSource::New { id: "history".into(), name: "History".into() },
    })) {
        Ok(outcome) => outcome.session.map(|view| view.session),
        Err(_) => None,
    };
    let tagged = |session, module, edit| {
        EditorCommand::EditScene(EditScene {
            target: SceneTarget::Session { session },
            edits: vec![edit],
            module: Some(module),
        })
    };
    let outcome = conflict.map(|history| {
        let built = workspace
            .execute(tagged(
                history,
                EditorModule::ObjectManager,
                SceneEdit::CreateObject(CreateObject { kind: "rect".into(), name: "Card".into() }),
            ))
            .and_then(|_| {
                workspace.execute(tagged(
                    history,
                    EditorModule::Timeline,
                    SceneEdit::CreateKeyframe(CreateKeyframe {
                        object_id: "rect-1".into(),
                        property: "x".into(),
                        keyframe: SceneKeyframe { frame: 0, value: 10.0, easing: SceneEasing::Linear, bezier: None },
                    }),
                ))
            });
        let before = workspace.view(history).ok();
        let result = workspace.execute(EditorCommand::Undo(Undo {
            session: history,
            module: Some(EditorModule::ObjectManager),
        }));
        let unchanged = before.is_some() && before == workspace.view(history).ok();
        (built.is_ok(), result, unchanged)
    });
    report.record(
        PLANE,
        "HistoryConflict is produced for a module undo a later command depends on",
        match outcome {
            Some((true, result, unchanged)) => expect(
                matches!(
                    refused(&result),
                    Some(Refusal::HistoryConflict { direction: HistoryDirection::Undo, detail, .. }) if detail.starts_with("[sceneObjectUnknown]")
                ) && unchanged,
                format!("expected HistoryConflict naming sceneObjectUnknown, got {result:?} (unchanged: {unchanged})"),
            ),
            _ => Outcome::Fail("the history session could not be built".into()),
        },
    );

    let (refusal, unchanged) = refuse_edit(workspace, session, Vec::new());
    report.record(
        PLANE,
        "EditBatchEmpty is produced for an edit batch with no edits",
        expect(
            matches!(refusal, Some(Refusal::EditBatchEmpty)) && unchanged,
            format!("expected EditBatchEmpty with no history entry, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let result = workspace.execute(EditorCommand::SaveScene(SaveScene {
        session,
        to: SaveTarget::Origin,
    }));
    report.record(
        PLANE,
        "SessionUnbound is produced for saving to the origin of a session with none",
        expect(
            matches!(refused(&result), Some(Refusal::SessionUnbound { session: named }) if *named == session),
            format!("expected SessionUnbound for {session:?}, got {result:?}"),
        ),
    );
}

fn drive_object_refusals(report: &mut Report, workspace: &mut Workspace, session: SessionKey, scene: &SceneDocument) {
    let field = |ids: &[&str], field: ObjectField| {
        SceneEdit::SetObjectField(SetObjectField {
            object_ids: ids.iter().map(|id| (*id).to_owned()).collect(),
            field,
        })
    };

    let (refusal, unchanged) = edit(workspace, session, field(&[], ObjectField::X(1.0)));
    report.record(
        PLANE,
        "EditTargetsEmpty is produced for an inspector edit selecting no object",
        expect(
            matches!(refusal, Some(Refusal::EditTargetsEmpty)) && unchanged,
            format!("expected EditTargetsEmpty leaving the session unchanged, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(workspace, session, field(&["card", "text"], ObjectField::Radius(4.0)));
    report.record(
        PLANE,
        "ObjectFieldNotApplicable is produced for a field one selected kind lacks",
        expect(
            matches!(&refusal, Some(Refusal::ObjectFieldNotApplicable { field, kinds }) if field == "radius" && kinds == &["text".to_owned()])
                && unchanged,
            format!("expected radius not applicable to text, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(workspace, session, field(&["card"], ObjectField::Opacity(1.5)));
    report.record(
        PLANE,
        "ObjectFieldValueInvalid is produced for an opacity outside 0 to 1",
        expect(
            matches!(&refusal, Some(Refusal::ObjectFieldValueInvalid { field, .. }) if field == "opacity") && unchanged,
            format!("expected an invalid opacity refusal, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let card_x = scene
        .objects
        .iter()
        .find(|object| object.base().id == "card")
        .map_or(0.0, |object| object.base().x);
    let (refusal, unchanged) = edit(workspace, session, field(&["card"], ObjectField::X(card_x)));
    report.record(
        PLANE,
        "ObjectFieldUnchanged is produced for a field already holding the value",
        expect(
            matches!(&refusal, Some(Refusal::ObjectFieldUnchanged { field }) if field == "x") && unchanged,
            format!("expected an unchanged x refusal with no history entry, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(
        workspace,
        session,
        SceneEdit::SetObjectVisible(SetObjectVisible {
            object_id: "hidden-child".into(),
            visible: false,
        }),
    );
    report.record(
        PLANE,
        "ObjectHiddenByParent is produced for toggling a child of a hidden group",
        expect(
            matches!(&refusal, Some(Refusal::ObjectHiddenByParent { object, parent }) if object == "hidden-child" && parent == "hidden-group")
                && unchanged,
            format!("expected hidden-child hidden by hidden-group, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(
        workspace,
        session,
        SceneEdit::SetObjectVisible(SetObjectVisible {
            object_id: "own-lock".into(),
            visible: false,
        }),
    );
    report.record(
        PLANE,
        "ObjectLocked is produced for hiding an object locked itself",
        expect(
            matches!(&refusal, Some(Refusal::ObjectLocked { object, owner }) if object == "own-lock" && owner == "own-lock")
                && unchanged,
            format!("expected own-lock locked by itself, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(
        workspace,
        session,
        SceneEdit::SetObjectLocked(SetObjectLocked {
            object_id: "locked-child".into(),
            locked: false,
        }),
    );
    report.record(
        PLANE,
        "ObjectLocked is produced for unlocking a child whose group holds the lock",
        expect(
            matches!(&refusal, Some(Refusal::ObjectLocked { object, owner }) if object == "locked-child" && owner == "locked-group")
                && unchanged,
            format!("expected locked-child locked by locked-group, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );
}

fn drive_binding_refusals(report: &mut Report, workspace: &mut Workspace, session: SessionKey, scene: &SceneDocument) {
    let (refusal, unchanged) = edit(workspace, session, set_binding("card", "text", Some("title")));
    report.record(
        PLANE,
        "BindingPropertyUnsupported is produced for binding a property the kind lacks",
        expect(
            matches!(&refusal, Some(Refusal::BindingPropertyUnsupported { object, kind, property }) if object == "card" && kind == "rect" && property == "text")
                && unchanged,
            format!("expected rect text unsupported, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(workspace, session, set_binding("card", "x", Some("absent")));
    report.record(
        PLANE,
        "BindingPathInvalid is produced for a path absent from the data context",
        expect(
            matches!(&refusal, Some(Refusal::BindingPathInvalid { path, .. }) if path == "absent") && unchanged,
            format!("expected an invalid path refusal for absent, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(workspace, session, set_binding("card", "x", Some("title")));
    report.record(
        PLANE,
        "BindingTypeMismatch is produced for binding a number to a string value",
        expect(
            matches!(&refusal, Some(Refusal::BindingTypeMismatch { property, path, expected, .. }) if property == "x" && path == "title" && expected == "number")
                && unchanged,
            format!("expected x expecting a number at title, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(workspace, session, set_binding("card", "opacity", Some("tooOpaque")));
    report.record(
        PLANE,
        "BindingValueOutOfRange is produced for an opacity value above 1",
        expect(
            matches!(&refusal, Some(Refusal::BindingValueOutOfRange { property, constraint, .. }) if property == "opacity" && constraint == "between 0 and 1")
                && unchanged,
            format!("expected opacity out of range, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(workspace, session, set_binding("logo", "assetId", Some("absentAsset")));
    report.record(
        PLANE,
        "BindingAssetUnknown is produced for an image bound to an asset the scene lacks",
        expect(
            matches!(&refusal, Some(Refusal::BindingAssetUnknown { object, asset, .. }) if object == "logo" && asset == "no-such-asset")
                && unchanged,
            format!("expected logo asset no-such-asset unknown, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(workspace, session, set_binding("card", "y", None));
    report.record(
        PLANE,
        "BindingNotBound is produced for unbinding a property with no binding",
        expect(
            matches!(&refusal, Some(Refusal::BindingNotBound { object, property }) if object == "card" && property == "y")
                && unchanged,
            format!("expected card y not bound, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let result = workspace.execute(EditorCommand::EditScene(EditScene {
        target: SceneTarget::Session { session },
        edits: vec![SceneEdit::ReplaceDataContext(ReplaceDataContext {
            data_context: scene.data_context.clone(),
        })],
        module: None,
    }));
    report.record(
        PLANE,
        "DataContextUnchanged is produced for replacing data with identical data",
        expect(
            matches!(refused(&result), Some(Refusal::DataContextUnchanged)),
            format!("expected DataContextUnchanged, got {result:?}"),
        ),
    );

    // The only accepted edit in this driver: it makes the session dirty, which
    // the close refusal needs, and gives the repeat a binding to collide with.
    let bound = workspace.execute(EditorCommand::EditScene(EditScene {
        target: SceneTarget::Session { session },
        edits: vec![set_binding("card", "x", Some("headline"))],
        module: None,
    }));
    let (refusal, unchanged) = edit(workspace, session, set_binding("card", "x", Some("headline")));
    report.record(
        PLANE,
        "BindingUnchanged is produced for binding a property to the path it already has",
        expect(
            bound.is_ok()
                && matches!(&refusal, Some(Refusal::BindingUnchanged { property, path, .. }) if property == "x" && path == "headline")
                && unchanged,
            format!("expected the first bind to succeed ({bound:?}) and the repeat to refuse BindingUnchanged, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let result = workspace.execute(EditorCommand::CloseScene(CloseScene { session, force: false }));
    let still_open = workspace.view(session).is_ok();
    report.record(
        PLANE,
        "SessionHasUnsavedChanges is produced for closing an edited session without force",
        expect(
            matches!(refused(&result), Some(Refusal::SessionHasUnsavedChanges { session: named, .. }) if *named == session)
                && still_open,
            format!("expected the dirty close to refuse and keep the session open, got {result:?} (open: {still_open})"),
        ),
    );
}

fn drive_material_and_scene_refusals(report: &mut Report, workspace: &mut Workspace, session: SessionKey) {
    let delete = |material: &str| {
        SceneEdit::DeleteMaterial(DeleteMaterial {
            material_id: material.into(),
        })
    };
    let relink = |from: &str, to: &str| {
        SceneEdit::RelinkMaterial(RelinkMaterial {
            from_material_id: from.into(),
            to_material_id: to.into(),
        })
    };

    let (refusal, unchanged) = edit(workspace, session, delete("m1"));
    report.record(
        PLANE,
        "MaterialInUse is produced for deleting a material an object still binds",
        expect(
            matches!(&refusal, Some(Refusal::MaterialInUse { material, users }) if material == "m1" && users == &["card".to_owned()])
                && unchanged,
            format!("expected m1 in use by card, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(workspace, session, delete("no-such-material"));
    report.record(
        PLANE,
        "MaterialUnknown is produced for deleting a material the library lacks",
        expect(
            matches!(&refusal, Some(Refusal::MaterialUnknown { material }) if material == "no-such-material") && unchanged,
            format!("expected no-such-material unknown, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(workspace, session, relink("m1", "m1"));
    report.record(
        PLANE,
        "MaterialRelinkSameMaterial is produced for relinking a material to itself",
        expect(
            matches!(&refusal, Some(Refusal::MaterialRelinkSameMaterial { material }) if material == "m1") && unchanged,
            format!("expected m1 relinked to itself to refuse, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(workspace, session, relink("m2", "m1"));
    report.record(
        PLANE,
        "MaterialRelinkNoUsers is produced for relinking a material nothing uses",
        expect(
            matches!(&refusal, Some(Refusal::MaterialRelinkNoUsers { material }) if material == "m2") && unchanged,
            format!("expected m2 to have no users, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(
        workspace,
        session,
        SceneEdit::ApplyPreset(ApplyPreset {
            object_id: "card".into(),
            preset_id: "no-such-preset".into(),
            phase: PresetPhase::In,
            at_frame: 0,
        }),
    );
    report.record(
        PLANE,
        "MotionPresetUnknown is produced for a preset id no starter preset has",
        expect(
            matches!(&refusal, Some(Refusal::MotionPresetUnknown { preset }) if preset == "no-such-preset") && unchanged,
            format!("expected no-such-preset unknown, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    // Fonts enter and leave only through these two edits (11.13); the witness
    // fixture's text object names font "font".
    let fixture_font = witness::fixture_scene().fonts[0].clone();
    let fixture_asset = witness::fixture_scene().assets[0].clone();
    let add = |fonts: Vec<gx_contracts::font::FontDefinition>, assets| {
        SceneEdit::AddFonts(AddFonts { fonts, assets })
    };
    let remove = |font: &str| SceneEdit::RemoveFont(RemoveFont { font_id: font.into() });

    let (refusal, unchanged) = edit(workspace, session, remove("font"));
    report.record(
        PLANE,
        "FontInUse is produced for removing a font a text object still names",
        expect(
            matches!(&refusal, Some(Refusal::FontInUse { font_id, objects, .. }) if font_id == "font" && objects == &["text".to_owned()])
                && unchanged,
            format!("expected font in use by text, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(workspace, session, remove("no-such-font"));
    report.record(
        PLANE,
        "FontUnknown is produced for removing a font the scene lacks",
        expect(
            matches!(&refusal, Some(Refusal::FontUnknown { font_id }) if font_id == "no-such-font") && unchanged,
            format!("expected no-such-font unknown, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(workspace, session, add(Vec::new(), Vec::new()));
    report.record(
        PLANE,
        "FontBatchEmpty is produced for adding no fonts",
        expect(
            matches!(&refusal, Some(Refusal::FontBatchEmpty)) && unchanged,
            format!("expected an empty font add to refuse, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(workspace, session, add(vec![fixture_font.clone()], Vec::new()));
    report.record(
        PLANE,
        "FontDuplicate is produced for adding a font id the scene already has",
        expect(
            matches!(&refusal, Some(Refusal::FontDuplicate { font_id }) if font_id == "font") && unchanged,
            format!("expected font duplicate, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let mut fresh_font = fixture_font;
    fresh_font.font_id = "fresh-font".into();
    let (refusal, unchanged) = edit(workspace, session, add(vec![fresh_font], vec![fixture_asset]));
    report.record(
        PLANE,
        "SceneAssetDuplicate is produced for adding an asset id the library already has",
        expect(
            matches!(&refusal, Some(Refusal::SceneAssetDuplicate { asset_id }) if asset_id == "asset1") && unchanged,
            format!("expected asset1 duplicate, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    // Imported assets enter only through addAssets (11.39); fonts never do.
    let (refusal, unchanged) = edit(workspace, session, SceneEdit::AddAssets(AddAssets { assets: Vec::new() }));
    report.record(
        PLANE,
        "AssetBatchEmpty is produced for adding no assets",
        expect(
            matches!(&refusal, Some(Refusal::AssetBatchEmpty)) && unchanged,
            format!("expected an empty asset add to refuse, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let mut font_asset = witness::fixture_scene().assets[0].clone();
    font_asset.asset_id = "font-bytes".into();
    font_asset.kind = gx_contracts::scene::AssetKind::Font;
    let (refusal, unchanged) = edit(workspace, session, SceneEdit::AddAssets(AddAssets { assets: vec![font_asset] }));
    report.record(
        PLANE,
        "AssetKindNotAddable is produced for adding a font asset without its font",
        expect(
            matches!(&refusal, Some(Refusal::AssetKindNotAddable { asset_id, kind: gx_contracts::scene::AssetKind::Font }) if asset_id == "font-bytes")
                && unchanged,
            format!("expected a font asset to be refused, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(workspace, session, SceneEdit::SetSceneName(SetSceneName { name: "   ".into() }));
    report.record(
        PLANE,
        "SceneNameEmpty is produced for renaming a scene to blank",
        expect(
            matches!(refusal, Some(Refusal::SceneNameEmpty)) && unchanged,
            format!("expected SceneNameEmpty, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );

    let (refusal, unchanged) = edit(workspace, session, SceneEdit::SetSceneId(SetSceneId { id: "../escape".into() }));
    report.record(
        PLANE,
        "SceneIdInvalid is produced for a scene id that is not a canonical filename",
        expect(
            matches!(&refusal, Some(Refusal::SceneIdInvalid { id }) if id == "../escape") && unchanged,
            format!("expected ../escape to be an invalid id, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );
}

fn drive_store_refusals(report: &mut Report, workspace: &mut Workspace, scratch: &Scratch) {
    let result = workspace.execute(EditorCommand::CreateProject(CreateProject {
        project: "../escape".into(),
    }));
    let escaped = wrote_anything_named(scratch.path(), "escape");
    report.record(
        PLANE,
        "ProjectNameInvalid is produced for a project name that leaves the store",
        expect(
            matches!(refused(&result), Some(Refusal::ProjectNameInvalid { project }) if project == "../escape") && !escaped,
            format!("expected ../escape refused without a directory being made, got {result:?} (escaped: {escaped})"),
        ),
    );

    let created = workspace.execute(EditorCommand::CreateProject(CreateProject {
        project: PROJECT.into(),
    }));
    let result = workspace.execute(EditorCommand::CreateProject(CreateProject {
        project: PROJECT.into(),
    }));
    report.record(
        PLANE,
        "ProjectAlreadyExists is produced for creating a project twice",
        expect(
            created.is_ok() && matches!(refused(&result), Some(Refusal::ProjectAlreadyExists { project }) if project == PROJECT),
            format!("expected the first create to succeed ({created:?}) and the second to refuse, got {result:?}"),
        ),
    );

    let create_scene = || {
        EditorCommand::CreateScene(CreateScene {
            project: PROJECT.into(),
            scene_id: STORED.into(),
            name: "Stored".into(),
        })
    };
    let created = workspace.execute(create_scene());
    let result = workspace.execute(create_scene());
    report.record(
        PLANE,
        "SceneAlreadyExists is produced for creating a stored scene twice",
        expect(
            created.is_ok()
                && matches!(refused(&result), Some(Refusal::SceneAlreadyExists { project, scene_id }) if project == PROJECT && scene_id == STORED),
            format!("expected the first create to succeed ({created:?}) and the second to refuse, got {result:?}"),
        ),
    );

    let result = workspace.execute(EditorCommand::DeleteScene(DeleteScene {
        project: PROJECT.into(),
        scene_id: "no-such-scene".into(),
    }));
    report.record(
        PLANE,
        "SceneNotStored is produced for deleting a scene the project does not hold",
        expect(
            matches!(refused(&result), Some(Refusal::SceneNotStored { project, scene_id }) if project == PROJECT && scene_id == "no-such-scene"),
            format!("expected no-such-scene not stored, got {result:?}"),
        ),
    );

    let result = workspace.execute(EditorCommand::SaveTakePage(SaveTakePage {
        project: PROJECT.into(),
        page: TakePage {
            page_id: "../escape".into(),
            name: "Escape".into(),
            scene_id: STORED.into(),
            values: Default::default(),
        },
    }));
    let escaped = wrote_anything_named(scratch.path(), "escape");
    report.record(
        PLANE,
        "TakePageIdInvalid is produced for a page id that leaves the project",
        expect(
            matches!(refused(&result), Some(Refusal::TakePageIdInvalid { page_id }) if page_id == "../escape") && !escaped,
            format!("expected ../escape refused as a page id, got {result:?} (escaped: {escaped})"),
        ),
    );

    let opened = workspace.execute(EditorCommand::OpenScene(OpenScene {
        source: SceneSource::Project {
            project: PROJECT.into(),
            scene_id: STORED.into(),
        },
    }));
    let bound = match opened.as_ref().map(|outcome| outcome.session.as_ref().map(|view| view.session)) {
        Ok(Some(bound)) => bound,
        other => {
            report.record(
                PLANE,
                "SceneIdBound is produced for changing the id of a stored scene in place",
                Outcome::Fail(format!("the stored scene did not open: {other:?}")),
            );
            return;
        }
    };
    let (refusal, unchanged) = edit(workspace, bound, SceneEdit::SetSceneId(SetSceneId { id: "renamed".into() }));
    report.record(
        PLANE,
        "SceneIdBound is produced for changing the id of a stored scene in place",
        expect(
            matches!(&refusal, Some(Refusal::SceneIdBound { project, scene_id }) if project == PROJECT && scene_id == STORED)
                && unchanged,
            format!("expected stored scene id bound, got {refusal:?} (unchanged: {unchanged})"),
        ),
    );
}
