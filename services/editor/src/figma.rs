//! Figma ingest (build plan 18.2): one frame, as an agent read it through Figma's MCP, becomes
//! one scene (18.3).
//!
//! The design is **agent-brokered**: the user's own agent calls Figma's `get_metadata` and hands
//! the text it got to `scenes.ingest_figma`. GrapiX holds no Figma token and makes no network
//! call; it parses that text deterministically, so the same text gives the same scene.
//!
//! What `get_metadata` carries is a tree of node id, kind, name, position, size and `hidden`.
//! It does **not** carry fills, strokes, effects, text content, fonts, corner radii, clipping or
//! auto-layout. This module maps what is there and **names what is not**: every node's report
//! entry says which of those the source holds that the scene does not. Nothing is guessed.
//!
//! Positions in the metadata are relative to the root frame's top-left, which is what a scene's
//! coordinates are, so they are carried over unchanged. The root frame itself becomes the canvas
//! (its width and height), not an object.

use gx_asset_plane::content_hash;
use gx_contracts::import::{ImportEntry, ImportReport, ImportTier, Substitution};
use gx_contracts::scene::{
    EllipseObject, GroupObject, ObjectBase, RectObject, SceneCanvas, SceneDocument, SceneObject,
    SceneTimeline,
};
use gx_contracts::{RationalRate, RefusalSeverity};

use crate::import::{retained_source, ImportFailure, ImportOutcome, SourceKind};

/// The largest tree one call takes. A frame past this is a design to split, not one to import whole.
pub const MAX_NODES: usize = 20_000;
/// The deepest nesting taken. Figma files stay far below this.
const MAX_DEPTH: usize = 64;
/// The largest canvas side, in pixels (the engine's own bound is lower; this only stops nonsense).
const MAX_SIDE: f64 = 16_384.0;

/// One node of the metadata tree.
#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub tag: String,
    pub id: String,
    pub name: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub hidden: bool,
    pub children: Vec<Node>,
}

/// Parse the frame's metadata text. Text before the first `<` and after the root closes (Figma
/// wraps the XML in sentences) is ignored; exactly one root element is required.
pub fn parse_metadata(text: &str) -> Result<Node, ImportFailure> {
    let malformed = |why: String| ImportFailure::Malformed(why);
    let bytes = text.as_bytes();
    let mut i = text
        .find('<')
        .ok_or_else(|| malformed("there is no XML in the metadata (a page list is not a frame: ask Figma for one frame's node id)".into()))?;
    let mut stack: Vec<Node> = Vec::new();
    let mut root: Option<Node> = None;
    let mut count = 0usize;

    while i < bytes.len() && root.is_none() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        let end = tag_end(text, i)
            .ok_or_else(|| malformed(format!("the tag opened at byte {i} is never closed")))?;
        let inner = &text[i + 1..end];
        i = end + 1;
        if let Some(closing) = inner.strip_prefix('/') {
            let node = stack
                .pop()
                .ok_or_else(|| malformed(format!("</{}> closes nothing", closing.trim())))?;
            if node.tag != closing.trim() {
                return Err(malformed(format!(
                    "<{}> is closed by </{}>",
                    node.tag,
                    closing.trim()
                )));
            }
            attach(&mut stack, &mut root, node);
            continue;
        }
        if inner.starts_with('!') || inner.starts_with('?') {
            continue;
        }
        let self_closing = inner.ends_with('/');
        let inner = inner.strip_suffix('/').unwrap_or(inner);
        let node = element(inner)?;
        count += 1;
        if count > MAX_NODES {
            return Err(malformed(format!(
                "more than {MAX_NODES} nodes: import one smaller frame at a time"
            )));
        }
        if stack.len() >= MAX_DEPTH {
            return Err(malformed(format!("nested deeper than {MAX_DEPTH} levels")));
        }
        if self_closing {
            attach(&mut stack, &mut root, node);
        } else {
            stack.push(node);
        }
    }
    if !stack.is_empty() {
        return Err(malformed(format!(
            "<{}> is never closed, so the metadata is cut short",
            stack.last().map_or("", |n| n.tag.as_str())
        )));
    }
    let root = root.ok_or_else(|| malformed("there is no element in the metadata".into()))?;
    // A second top-level element means more than one frame was selected.
    if text[i..].contains('<') {
        return Err(malformed(
            "more than one top-level element: a frame is one scene, so import one frame per call"
                .into(),
        ));
    }
    Ok(root)
}

fn attach(stack: &mut [Node], root: &mut Option<Node>, node: Node) {
    match stack.last_mut() {
        Some(parent) => parent.children.push(node),
        None => *root = Some(node),
    }
}

/// The index of the `>` that ends the tag opened at `start`, skipping any `>` inside a quoted value.
fn tag_end(text: &str, start: usize) -> Option<usize> {
    let mut quote: Option<u8> = None;
    for (offset, byte) in text.as_bytes()[start + 1..].iter().enumerate() {
        match (quote, *byte) {
            (Some(q), b) if b == q => quote = None,
            (Some(_), _) => {}
            (None, b'"' | b'\'') => quote = Some(*byte),
            (None, b'>') => return Some(start + 1 + offset),
            _ => {}
        }
    }
    None
}

fn element(inner: &str) -> Result<Node, ImportFailure> {
    let inner = inner.trim();
    let tag_len = inner.find(char::is_whitespace).unwrap_or(inner.len());
    let tag = &inner[..tag_len];
    if tag.is_empty() {
        return Err(ImportFailure::Malformed("an element with no name".into()));
    }
    let mut node = Node {
        tag: tag.to_owned(),
        id: String::new(),
        name: String::new(),
        x: None,
        y: None,
        width: None,
        height: None,
        hidden: false,
        children: Vec::new(),
    };
    let mut rest = &inner[tag_len..];
    while let Some(equals) = rest.find('=') {
        let name = rest[..equals].trim();
        let after = &rest[equals + 1..];
        let Some(quote) = after.chars().next().filter(|c| matches!(c, '"' | '\'')) else {
            return Err(ImportFailure::Malformed(format!(
                "the attribute {name} of <{tag}> has an unquoted value"
            )));
        };
        let Some(close) = after[1..].find(quote) else {
            return Err(ImportFailure::Malformed(format!(
                "the attribute {name} of <{tag}> is never closed"
            )));
        };
        let value = decode(&after[1..1 + close]);
        match name {
            "id" => node.id = value,
            "name" => node.name = value,
            "x" => node.x = number(&value),
            "y" => node.y = number(&value),
            "width" => node.width = number(&value),
            "height" => node.height = number(&value),
            "hidden" => node.hidden = value == "true",
            _ => {}
        }
        rest = &after[1 + close + 1..];
    }
    if node.id.is_empty() {
        return Err(ImportFailure::Malformed(format!(
            "a <{tag}> has no id, so the report could not name it"
        )));
    }
    Ok(node)
}

fn number(text: &str) -> Option<f64> {
    text.trim().parse::<f64>().ok().filter(|n| n.is_finite())
}

/// The five XML entities Figma writes in a name.
fn decode(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

pub(crate) fn substitution(
    feature: &str,
    replaced_with: &str,
    reason: &str,
    severity: RefusalSeverity,
) -> Substitution {
    Substitution {
        source_feature: feature.to_owned(),
        replaced_with: replaced_with.to_owned(),
        reason: reason.to_owned(),
        severity,
    }
}

const NOT_IN_METADATA: &str = "Figma's get_metadata carries id, kind, name, position and size only";

struct Builder {
    objects: Vec<SceneObject>,
    entries: Vec<ImportEntry>,
    z: i32,
}

impl Builder {
    fn base(&mut self, node: &Node, origin: (f64, f64)) -> ObjectBase {
        let mut base = ObjectBase::new(&node.id, display_name(node));
        base.x = node.x.unwrap_or(0.0) - origin.0;
        base.y = node.y.unwrap_or(0.0) - origin.1;
        base.width = node.width.unwrap_or(0.0).max(0.0);
        base.height = node.height.unwrap_or(0.0).max(0.0);
        base.visible = !node.hidden;
        base.z_index = self.z;
        self.z += 1;
        base
    }

    fn entry(
        &mut self,
        node: &Node,
        tier: ImportTier,
        object: bool,
        substitutions: Vec<Substitution>,
    ) {
        self.entries.push(ImportEntry {
            source_id: node.id.clone(),
            source_name: display_name(node),
            tier,
            object_id: object.then(|| node.id.clone()),
            substitutions,
        });
    }

    /// Add one node and, for a container, its children. Returns the object ids this node
    /// contributed at its own level (itself, or nothing when it was dropped).
    fn add(&mut self, node: &Node, origin: (f64, f64)) -> Option<String> {
        let has_box = node.width.is_some() && node.height.is_some();
        match node.tag.as_str() {
            "rectangle" | "rounded-rectangle" => {
                let base = self.base(node, origin);
                self.objects
                    .push(SceneObject::Rect(RectObject { base, radius: 0.0 }));
                let mut subs = vec![substitution(
                    "figma:fills, strokes and effects",
                    "no fill and no stroke",
                    NOT_IN_METADATA,
                    RefusalSeverity::Warning,
                )];
                if node.tag == "rounded-rectangle" {
                    subs.push(substitution(
                        "figma:corner radius",
                        "square corners",
                        NOT_IN_METADATA,
                        RefusalSeverity::Warning,
                    ));
                }
                self.entry(node, ImportTier::Native, true, subs);
                Some(node.id.clone())
            }
            "ellipse" => {
                let base = self.base(node, origin);
                self.objects
                    .push(SceneObject::Ellipse(EllipseObject { base }));
                self.entry(
                    node,
                    ImportTier::Native,
                    true,
                    vec![substitution(
                        "figma:fills, strokes and effects",
                        "no fill and no stroke",
                        NOT_IN_METADATA,
                        RefusalSeverity::Warning,
                    )],
                );
                Some(node.id.clone())
            }
            // A node with children keeps its structure as a group; its own paint, clip and
            // layout are not in the metadata.
            _ if !node.children.is_empty() => {
                let base = self.base(node, origin);
                let index = self.objects.len();
                self.objects.push(SceneObject::Group(GroupObject {
                    base,
                    child_ids: Vec::new(),
                    clip_child_id: None,
                }));
                let child_ids: Vec<String> = node
                    .children
                    .iter()
                    .filter_map(|child| self.add(child, origin))
                    .collect();
                if let SceneObject::Group(group) = &mut self.objects[index] {
                    group.child_ids = child_ids;
                }
                self.entry(
                    node,
                    ImportTier::Container,
                    true,
                    vec![substitution(
                        &format!("figma:{} fill, clip and auto-layout", node.tag),
                        "a group container",
                        NOT_IN_METADATA,
                        RefusalSeverity::Info,
                    )],
                );
                Some(node.id.clone())
            }
            // A leaf whose pixels or text the metadata does not hold: an empty box keeps its
            // place so the layout is right and the loss is on the report.
            _ if has_box => {
                let base = self.base(node, origin);
                self.objects
                    .push(SceneObject::Rect(RectObject { base, radius: 0.0 }));
                let (feature, replaced, reason) = match node.tag.as_str() {
                    "text" => (
                        "figma:text content, font and style".to_owned(),
                        "an empty box where the text goes".to_owned(),
                        format!("{NOT_IN_METADATA}; read get_design_context and create the text with scenes.edit"),
                    ),
                    other => (
                        format!("figma:{other} pixels or vector geometry"),
                        "an empty box at the node's position and size".to_owned(),
                        format!("{NOT_IN_METADATA}; export the node as an image or SVG and import that"),
                    ),
                };
                self.entry(
                    node,
                    ImportTier::Flattened,
                    true,
                    vec![substitution(
                        &feature,
                        &replaced,
                        &reason,
                        RefusalSeverity::Warning,
                    )],
                );
                Some(node.id.clone())
            }
            // No box at all: nothing can be placed, and saying so is the point.
            other => {
                self.entry(
                    node,
                    ImportTier::Rasterized,
                    false,
                    vec![substitution(
                        &format!("figma:{other}"),
                        "nothing",
                        "the node has no position or size in the metadata, so it cannot be placed",
                        RefusalSeverity::Error,
                    )],
                );
                None
            }
        }
    }
}

fn display_name(node: &Node) -> String {
    if node.name.trim().is_empty() {
        node.id.clone()
    } else {
        node.name.clone()
    }
}

/// Import one frame's `get_metadata` text into a scene, reporting every departure.
pub fn import_figma_metadata(
    source_name: &str,
    metadata: &str,
    scene_id: &str,
) -> Result<ImportOutcome, ImportFailure> {
    let root = parse_metadata(metadata)?;
    let side = |value: Option<f64>, what: &str| match value {
        Some(v) if (1.0..=MAX_SIDE).contains(&v) => Ok(v.round() as u32),
        other => Err(ImportFailure::Malformed(format!(
            "the root frame's {what} is {other:?}; a scene needs 1 to {MAX_SIDE} pixels"
        ))),
    };
    let width = side(root.width, "width")?;
    let height = side(root.height, "height")?;

    let mut builder = Builder {
        objects: Vec::new(),
        entries: Vec::new(),
        z: 0,
    };
    // The root's children carry coordinates relative to the root already, so the origin is zero.
    for child in &root.children {
        builder.add(child, (0.0, 0.0));
    }
    // The root is the canvas: its own fill and clip are the scene background, not in the metadata.
    builder.entries.push(ImportEntry {
        source_id: root.id.clone(),
        source_name: display_name(&root),
        tier: ImportTier::Container,
        object_id: None,
        substitutions: vec![substitution(
            &format!("figma:{} fill and clip", root.tag),
            "the scene canvas, with no background",
            NOT_IN_METADATA,
            RefusalSeverity::Warning,
        )],
    });

    let bytes = metadata.as_bytes();
    let scene = SceneDocument {
        // Figma composites in sRGB unless the file says otherwise, and the metadata does not.
        working_color_space: gx_contracts::color::WorkingColorSpace::Srgb,
        color_depth: gx_contracts::color::ColorDepth::NEW_PROJECT,
        id: scene_id.to_owned(),
        name: display_name(&root),
        version: gx_contracts::scene::SCENE_SCHEMA_VERSION,
        revision: None,
        active_camera_id: None,
        canvas: SceneCanvas {
            width,
            height,
            frame_rate: RationalRate::P50,
        },
        timeline: SceneTimeline {
            duration_frames: 1,
            ..Default::default()
        },
        data_context: Default::default(),
        assets: vec![retained_source(
            source_name,
            bytes,
            SourceKind::FigmaMetadata,
        )],
        fonts: Vec::new(),
        materials: Vec::new(),
        controls: Vec::new(),
        text_styles: Vec::new(),
        path_links: Vec::new(),
        guides: Vec::new(),
        scene_label: None,
        objects: builder.objects,
    };
    let report = ImportReport {
        source_format: "figma".into(),
        source_name: source_name.to_owned(),
        source_hash: Some(content_hash(bytes)),
        entries: builder.entries,
    };
    report
        .validate()
        .map_err(|error| ImportFailure::UnexplainedLoss(error.to_string()))?;
    Ok(ImportOutcome { scene, report })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from a real `get_metadata` reply (Figma desktop, 20 Nov 2026): the sentence
    /// before the XML, a hidden instance, a nested frame, a leaf frame, text and an entity.
    const REAL: &str = r#"Currently selected nodes:
- 3300:2528: Full-Screen · Qualified for Finals v1

<frame id="3300:2528" name="Full-Screen · Qualified for Finals v1" x="2098" y="20202" width="1920" height="1080">
  <frame id="3300:2530" name="Background" x="0" y="0" width="1920" height="1080">
    <instance id="3300:2531" name="BG Style" x="0" y="0" width="1920" height="1080" hidden="true" />
    <rounded-rectangle id="3300:2532" name="BG · PIC plate" x="0" y="0" width="1920" height="1080" />
    <frame id="3300:2538" name="Logo · TWIS" x="130.52734375" y="342.4871826171875" width="104.53811645507812" height="131.7075958251953" />
  </frame>
  <instance id="3300:2615" name="Logo · Mono &amp; Year" x="1736" y="80" width="103.94341278076172" height="92.00000762939453" />
  <text id="3300:2616" name="Context" x="80" y="80" width="428" height="29" />
</frame>IMPORTANT: After you call this tool, you MUST call get_design_context."#;

    fn find<'a>(scene: &'a SceneDocument, id: &str) -> &'a SceneObject {
        scene
            .objects
            .iter()
            .find(|o| o.base().id == id)
            .unwrap_or_else(|| panic!("no object {id}"))
    }

    #[test]
    fn a_real_reply_becomes_one_scene_the_size_of_its_frame() {
        let out = import_figma_metadata("lower.xml", REAL, "finals").unwrap();
        assert_eq!(
            (out.scene.canvas.width, out.scene.canvas.height),
            (1920, 1080)
        );
        assert_eq!(out.scene.name, "Full-Screen · Qualified for Finals v1");
        // The root is the canvas, not an object; every other node is one.
        let ids: Vec<_> = out
            .scene
            .objects
            .iter()
            .map(|o| o.base().id.as_str())
            .collect();
        assert_eq!(
            ids,
            [
                "3300:2530",
                "3300:2531",
                "3300:2532",
                "3300:2538",
                "3300:2615",
                "3300:2616"
            ]
        );
    }

    #[test]
    fn positions_hierarchy_visibility_and_order_are_kept() {
        let out = import_figma_metadata("f.xml", REAL, "s").unwrap();
        let SceneObject::Group(background) = find(&out.scene, "3300:2530") else {
            panic!("the Background frame is a group");
        };
        assert_eq!(
            background.child_ids,
            ["3300:2531", "3300:2532", "3300:2538"],
            "children in Figma's order"
        );
        let logo = find(&out.scene, "3300:2538").base();
        assert_eq!((logo.x, logo.y), (130.52734375, 342.4871826171875));
        assert!(
            !find(&out.scene, "3300:2531").base().visible,
            "hidden stays hidden"
        );
        assert!(find(&out.scene, "3300:2532").base().visible);
        let z: Vec<_> = out.scene.objects.iter().map(|o| o.base().z_index).collect();
        assert!(z.windows(2).all(|w| w[0] < w[1]), "later is on top: {z:?}");
        assert_eq!(
            find(&out.scene, "3300:2615").base().name,
            "Logo · Mono & Year"
        );
    }

    #[test]
    fn what_the_metadata_does_not_hold_is_named_for_every_node() {
        let out = import_figma_metadata("f.xml", REAL, "s").unwrap();
        out.report.validate().unwrap();
        let by_id = |id: &str| {
            out.report
                .entries
                .iter()
                .find(|e| e.source_id == id)
                .unwrap_or_else(|| panic!("no entry {id}"))
        };
        assert_eq!(by_id("3300:2532").tier, ImportTier::Native);
        let rect_features: Vec<_> = by_id("3300:2532")
            .substitutions
            .iter()
            .map(|s| s.source_feature.as_str())
            .collect();
        assert_eq!(
            rect_features,
            ["figma:fills, strokes and effects", "figma:corner radius"]
        );
        assert_eq!(by_id("3300:2530").tier, ImportTier::Container);
        let text = by_id("3300:2616");
        assert_eq!(text.tier, ImportTier::Flattened);
        assert!(text.substitutions[0]
            .source_feature
            .contains("text content"));
        assert!(text.substitutions[0].reason.contains("scenes.edit"));
        let root = by_id("3300:2528");
        assert_eq!(root.object_id, None, "the root is the canvas");
        assert!(root.substitutions[0]
            .source_feature
            .contains("fill and clip"));
        assert_eq!(out.report.source_format, "figma");
        assert_eq!(out.report.source_hash, Some(content_hash(REAL.as_bytes())));
    }

    #[test]
    fn the_same_text_gives_the_same_scene() {
        assert_eq!(
            import_figma_metadata("f.xml", REAL, "s").unwrap(),
            import_figma_metadata("f.xml", REAL, "s").unwrap()
        );
    }

    #[test]
    fn a_node_with_no_box_is_reported_not_skipped() {
        let xml = r#"<frame id="1:1" name="A" x="0" y="0" width="10" height="10"><vector id="1:2" name="v"/></frame>"#;
        let out = import_figma_metadata("f.xml", xml, "s").unwrap();
        assert!(out.scene.objects.is_empty());
        let entry = out
            .report
            .entries
            .iter()
            .find(|e| e.source_id == "1:2")
            .unwrap();
        assert_eq!(
            (entry.tier, entry.object_id.clone()),
            (ImportTier::Rasterized, None)
        );
        assert_eq!(entry.substitutions[0].severity, RefusalSeverity::Error);
    }

    #[test]
    fn an_ellipse_is_native() {
        let xml = r#"<frame id="1:1" name="A" x="0" y="0" width="10" height="10"><ellipse id="1:2" name="dot" x="1" y="2" width="4" height="4"/></frame>"#;
        let out = import_figma_metadata("f.xml", xml, "s").unwrap();
        assert!(matches!(find(&out.scene, "1:2"), SceneObject::Ellipse(_)));
    }

    #[test]
    fn a_quoted_angle_bracket_does_not_end_a_tag() {
        let xml = r#"<frame id="1:1" name="a &gt; b" x="0" y="0" width="10" height="10"><rectangle id="1:2" name="x > y" x="0" y="0" width="1" height="1"/></frame>"#;
        let out = import_figma_metadata("f.xml", xml, "s").unwrap();
        assert_eq!(out.scene.name, "a > b");
        assert_eq!(find(&out.scene, "1:2").base().name, "x > y");
    }

    #[test]
    fn a_cut_short_page_list_or_multi_frame_source_is_refused() {
        let cases = [
            ("<frame id=\"1:1\" width=\"10\" height=\"10\"><rectangle id=\"1:2\"", "never closed"),
            ("<frame id=\"1:1\" width=\"10\" height=\"10\">", "cut short"),
            ("Pages:\n- 0:1 Page 1\n- 0:2 Page 2", "no XML"),
            (
                "<frame id=\"1:1\" width=\"10\" height=\"10\"/><frame id=\"1:2\" width=\"10\" height=\"10\"/>",
                "one frame per call",
            ),
            ("<frame id=\"1:1\"><rectangle id=\"1:2\"></frame>", "is closed by"),
            ("<frame width=\"10\" height=\"10\"/>", "no id"),
            ("<frame id=\"1:1\" width=0 height=\"10\"/>", "unquoted"),
        ];
        for (xml, says) in cases {
            let error = import_figma_metadata("f.xml", xml, "s").expect_err(xml);
            assert!(
                matches!(error, ImportFailure::Malformed(_)),
                "{xml}: {error:?}"
            );
            assert!(error.to_string().contains(says), "{xml}: {error}");
        }
    }

    #[test]
    fn a_root_with_no_usable_size_is_refused() {
        for xml in [
            r#"<frame id="1:1" name="A"/>"#,
            r#"<frame id="1:1" width="0" height="10"/>"#,
            r#"<frame id="1:1" width="10" height="99999"/>"#,
        ] {
            assert!(import_figma_metadata("f.xml", xml, "s").is_err(), "{xml}");
        }
    }

    #[test]
    fn an_oversized_tree_is_refused_before_it_is_built() {
        let mut xml = String::from(r#"<frame id="0:0" width="10" height="10">"#);
        for i in 0..=MAX_NODES {
            xml.push_str(&format!(r#"<rectangle id="1:{i}" width="1" height="1"/>"#));
        }
        xml.push_str("</frame>");
        let error = import_figma_metadata("f.xml", &xml, "s").unwrap_err();
        assert!(error.to_string().contains("more than"), "{error}");
    }
}
