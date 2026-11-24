//! Track matte inspection views (plan row 3.30; Masking spec v2, section 6.5): what a layer's matte is, seen on its own, drawn by the
//! engine like any other frame.
//!
//! A view is a changed COPY of the document for one preview: nothing authored is touched, and the engine renders it as it renders every
//! scene, so what is shown is what the compositor does. `alpha` draws the matte source's alpha as white (its pixels before its own matte,
//! after its masks and effects); `luma` draws its luma (`alpha * Y` of the straight colour, Rec.709 weights); `applied` draws the layer
//! after its matte with nothing else; `before` draws it without.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::color::Rgba;
use crate::effect::{ChannelMixer, Effect, EffectInstance, Fill, MixerRow};
use crate::scene::{resolve_hierarchy, SceneDocument};
use crate::Refusal;

/// Which view of a track matte.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MatteView {
    /// The matte source's alpha, white on nothing.
    Alpha,
    /// The matte source's luma: `alpha * Y(straight colour)`.
    Luma,
    /// The layer as the matte leaves it, alone.
    Applied,
    /// The layer without its matte, alone.
    Before,
}

/// A request to see one layer's matte.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MatteViewRequest {
    /// The layer that HAS the matte.
    pub object_id: String,
    pub view: MatteView,
}

/// `document` changed for one preview of `request`, or why it cannot be. The layer must have a matte whose source is in the scene.
pub fn matte_view_document(document: &SceneDocument, request: &MatteViewRequest) -> Result<SceneDocument, Refusal> {
    let invalid = |field: &str, detail: String| Refusal::ObjectFieldValueInvalid { field: field.into(), detail };
    let Some(target) = document.objects.iter().find(|o| o.base().id == request.object_id) else {
        return Err(Refusal::SceneObjectUnknown { object_id: request.object_id.clone() });
    };
    let Some(matte) = target.base().track_matte() else {
        return Err(invalid("trackMatte", format!("{} has no track matte to look at", target.base().name)));
    };
    let source_id = matte.source_id.clone();
    if !document.objects.iter().any(|o| o.base().id == source_id) {
        return Err(Refusal::TrackMatteInvalid {
            object: request.object_id.clone(),
            detail: format!("the track matte source {source_id} is not in the scene"),
        });
    }
    let (shown, hidden_but_kept): (&str, Option<&str>) = match request.view {
        MatteView::Alpha | MatteView::Luma => (source_id.as_str(), None),
        MatteView::Applied => (request.object_id.as_str(), Some(source_id.as_str())),
        MatteView::Before => (request.object_id.as_str(), None),
    };
    // What stays in the picture: the shown layer and the groups above it, so it keeps the place its parents give it.
    let parents: std::collections::HashMap<String, String> = resolve_hierarchy(&document.objects)
        .edges
        .iter()
        .map(|edge| (edge.child_id.clone(), edge.parent_id.clone()))
        .collect();
    let mut with_parents: Vec<String> = vec![shown.to_owned()];
    let mut at = shown.to_owned();
    while let Some(parent) = parents.get(&at) {
        if with_parents.contains(parent) {
            break;
        }
        with_parents.push(parent.clone());
        at = parent.clone();
    }
    let mut view = document.clone();
    for object in &mut view.objects {
        let id = object.base().id.clone();
        let in_picture = with_parents.contains(&id);
        let base = object.base_mut();
        base.visible = in_picture && hidden_but_kept != Some(id.as_str());
        if hidden_but_kept == Some(id.as_str()) {
            // The matte still reads the source: it only is not drawn.
            base.visible = false;
        }
        if id == shown {
            match request.view {
                MatteView::Alpha | MatteView::Luma => {
                    // The source before its own matte, in normal blending, then the view's effect on top of its own.
                    base.track_matte = None;
                    base.blend_mode = None;
                    let effect = if request.view == MatteView::Alpha {
                        Effect::Fill(Fill { color: Rgba::srgb(1.0, 1.0, 1.0, 1.0), opacity: 1.0 })
                    } else {
                        Effect::ChannelMixer(ChannelMixer {
                            red: MixerRow { red: 0.2126, green: 0.7152, blue: 0.0722, constant: 0.0 },
                            green: MixerRow { red: 0.0, green: 1.0, blue: 0.0, constant: 0.0 },
                            blue: MixerRow { red: 0.0, green: 0.0, blue: 1.0, constant: 0.0 },
                            monochrome: true,
                        })
                    };
                    let mut effects = base.effects.take().unwrap_or_default();
                    effects.push(EffectInstance::new("matte-view", effect));
                    base.effects = Some(effects);
                }
                MatteView::Before => base.track_matte = None,
                MatteView::Applied => {}
            }
        }
    }
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::WorkingColorSpace;
    use crate::scene::{new_scene, GroupObject, ObjectBase, RectObject, SceneObject, TrackMatte, TrackMatteMode};

    fn rect(id: &str) -> SceneObject {
        SceneObject::Rect(RectObject { base: ObjectBase::new(id, id), radius: 0.0 })
    }

    fn scene() -> SceneDocument {
        let mut s = new_scene("s", "S", WorkingColorSpace::NEW_PROJECT);
        let mut card = rect("card");
        card.base_mut().track_matte = Some(TrackMatte { source_id: "disc".into(), mode: TrackMatteMode::Luma });
        s.objects = vec![card, rect("disc"), rect("other")];
        s
    }

    fn view(request: MatteView) -> Result<SceneDocument, Refusal> {
        matte_view_document(&scene(), &MatteViewRequest { object_id: "card".into(), view: request })
    }

    fn visible(doc: &SceneDocument) -> Vec<&str> {
        doc.objects.iter().filter(|o| o.base().visible).map(|o| o.base().id.as_str()).collect()
    }

    #[test]
    fn each_view_shows_one_layer_and_changes_only_the_copy() {
        let original = scene();
        let alpha = view(MatteView::Alpha).unwrap();
        assert_eq!(visible(&alpha), ["disc"]);
        assert!(alpha.objects[1].base().effects().iter().any(|e| e.effect_id == "matte-view"));
        let luma = view(MatteView::Luma).unwrap();
        assert!(matches!(luma.objects[1].base().effects()[0].effect, Effect::ChannelMixer(ref m) if m.monochrome));
        // The layer after its matte: shown alone, the source kept for the matte and not drawn.
        let applied = view(MatteView::Applied).unwrap();
        assert_eq!(visible(&applied), ["card"]);
        assert!(applied.objects[0].base().track_matte().is_some());
        assert!(applied.objects.iter().any(|o| o.base().id == "disc"));
        // Without its matte.
        let before = view(MatteView::Before).unwrap();
        assert_eq!(visible(&before), ["card"]);
        assert!(before.objects[0].base().track_matte().is_none());
        // Nothing authored changed.
        assert_eq!(scene(), original);
    }

    #[test]
    fn a_source_in_a_group_keeps_its_parents_and_a_missing_matte_is_refused_by_name() {
        let mut s = scene();
        s.objects.push(SceneObject::Group(GroupObject {
            base: ObjectBase::new("holder", "holder"),
            child_ids: vec!["disc".into()],
            clip_child_id: None,
        }));
        let doc = matte_view_document(&s, &MatteViewRequest { object_id: "card".into(), view: MatteView::Alpha }).unwrap();
        assert_eq!(visible(&doc), ["disc", "holder"]);
        let none = matte_view_document(&s, &MatteViewRequest { object_id: "other".into(), view: MatteView::Alpha });
        assert!(matches!(none, Err(Refusal::ObjectFieldValueInvalid { field, .. }) if field == "trackMatte"));
        s.objects.retain(|o| o.base().id != "disc");
        assert!(matches!(
            matte_view_document(&s, &MatteViewRequest { object_id: "card".into(), view: MatteView::Alpha }),
            Err(Refusal::TrackMatteInvalid { .. })
        ));
        assert!(matches!(
            matte_view_document(&s, &MatteViewRequest { object_id: "ghost".into(), view: MatteView::Alpha }),
            Err(Refusal::SceneObjectUnknown { .. })
        ));
    }
}
