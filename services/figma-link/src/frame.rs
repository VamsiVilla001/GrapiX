//! The calls Claude makes to Figma's MCP, typed.
//!
//! An agent given a Figma link does four things: it reads the file key and node id out of the
//! URL (`node-id=1-2` means node `1:2`), asks for the frame's metadata, its design context and
//! a screenshot, and sometimes its variables; it then treats every reply as **data**: text and
//! images in content blocks, an `isError` result as a failure. This module does the same, so
//! GrapiX reads a frame the way Claude does and nothing in a reply is ever run or obeyed.

use serde_json::{json, Value};

use crate::{Link, LinkError, Reply};

/// A frame named by a Figma URL (or a bare node id when Figma's selection is meant).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeRef {
    /// The file key, or the branch key for a branch URL. `None` for a bare node id.
    pub file_key: Option<String>,
    /// The node id in Figma's `1:2` form.
    pub node_id: String,
}

impl NodeRef {
    /// `https://www.figma.com/design/<key>/<name>?node-id=1-2`, `/file/`, `/board/`, `/make/`,
    /// a branch URL (`/design/<key>/branch/<branchKey>/..`), or a bare `1:2` / `1-2`.
    pub fn parse(text: &str) -> Result<Self, LinkError> {
        let text = text.trim();
        let bad = |why: &str| LinkError::Protocol(format!("not a Figma frame link: {why}"));
        if !text.contains('/') {
            return Ok(Self {
                file_key: None,
                node_id: node_id(text).ok_or_else(|| bad("the node id is not like 1:2"))?,
            });
        }
        let rest = text
            .strip_prefix("https://")
            .ok_or_else(|| bad("only https links"))?;
        let (host, path_and_query) = rest.split_once('/').ok_or_else(|| bad("no path"))?;
        if host != "figma.com" && host != "www.figma.com" {
            return Err(bad("not a figma.com link"));
        }
        let (path, query) = path_and_query
            .split_once('?')
            .map_or((path_and_query, ""), |(p, q)| (p, q));
        let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
        let file_key = match parts.as_slice() {
            ["design" | "file" | "board" | "make", _, "branch", branch, ..] => *branch,
            ["design" | "file" | "board" | "make", key, ..] => *key,
            _ => return Err(bad("no design, file, board or make path")),
        };
        let query_node = query
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .find(|(name, _)| *name == "node-id")
            .map(|(_, value)| value)
            .ok_or_else(|| bad("no node-id"))?;
        Ok(Self {
            file_key: Some(file_key.to_owned()),
            node_id: node_id(query_node).ok_or_else(|| bad("the node-id is not like 1-2"))?,
        })
    }

    fn arguments(&self) -> serde_json::Map<String, Value> {
        let mut args = serde_json::Map::new();
        args.insert("nodeId".into(), json!(self.node_id));
        if let Some(key) = &self.file_key {
            args.insert("fileKey".into(), json!(key));
        }
        args
    }
}

/// `1-2`, `1:2` or `1%3A2` as `1:2`; anything else is `None`.
fn node_id(text: &str) -> Option<String> {
    let text = text.replace("%3A", ":").replace("%3a", ":");
    let (a, b) = text.split_once([':', '-'])?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    (digits(a) && digits(b)).then(|| format!("{a}:{b}"))
}

/// One block of a tool result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Content {
    Text(String),
    /// A base64 image and its media type, as sent.
    Image {
        mime: String,
        data: String,
    },
    /// A block this version does not know, kept as it came.
    Other(String),
}

impl Reply {
    /// The result's content blocks. A result flagged `isError` is an error carrying its text:
    /// a tool that says it failed has failed, whatever else the reply holds.
    pub fn content(&self) -> Result<Vec<Content>, LinkError> {
        let blocks: Vec<Content> = self.result["content"]
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|block| match block["type"].as_str() {
                        Some("text") => Content::Text(block["text"].as_str().unwrap_or("").into()),
                        Some("image") => Content::Image {
                            mime: block["mimeType"].as_str().unwrap_or("").into(),
                            data: block["data"].as_str().unwrap_or("").into(),
                        },
                        _ => Content::Other(block.to_string()),
                    })
                    .collect()
            })
            .unwrap_or_default();
        if self.result["isError"] == json!(true) {
            let text = blocks
                .iter()
                .filter_map(|b| match b {
                    Content::Text(t) => Some(t.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            return Err(LinkError::Tool(text));
        }
        Ok(blocks)
    }

    /// All the text blocks, joined.
    pub fn text(&self) -> Result<String, LinkError> {
        Ok(self
            .content()?
            .into_iter()
            .filter_map(|b| match b {
                Content::Text(t) => Some(t),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"))
    }
}

impl Link {
    /// The frame's structure: layers, names, positions, sizes (Figma's `get_metadata`).
    pub fn get_metadata(&mut self, node: &NodeRef) -> Result<Reply, LinkError> {
        self.call("get_metadata", Value::Object(node.arguments()))
    }

    /// The frame's design context: layout, styles, text, asset references (`get_design_context`).
    pub fn get_design_context(&mut self, node: &NodeRef) -> Result<Reply, LinkError> {
        let mut args = node.arguments();
        args.insert("clientLanguages".into(), json!("rust,typescript"));
        args.insert("clientFrameworks".into(), json!("tauri"));
        self.call("get_design_context", Value::Object(args))
    }

    /// A picture of the frame, the visual target (`get_screenshot`).
    pub fn get_screenshot(&mut self, node: &NodeRef) -> Result<Reply, LinkError> {
        self.call("get_screenshot", Value::Object(node.arguments()))
    }

    /// The variables (colours, sizes, fonts) the frame uses (`get_variable_defs`).
    pub fn get_variable_defs(&mut self, node: &NodeRef) -> Result<Reply, LinkError> {
        self.call("get_variable_defs", Value::Object(node.arguments()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(file: Option<&str>, id: &str) -> NodeRef {
        NodeRef {
            file_key: file.map(Into::into),
            node_id: id.into(),
        }
    }

    #[test]
    fn a_design_link_gives_its_key_and_node() {
        assert_eq!(
            NodeRef::parse("https://www.figma.com/design/AbC123/My-File?node-id=12-34&t=zz")
                .unwrap(),
            node(Some("AbC123"), "12:34")
        );
        assert_eq!(
            NodeRef::parse("https://figma.com/file/K9/x?m=auto&node-id=1%3A2").unwrap(),
            node(Some("K9"), "1:2")
        );
        assert_eq!(
            NodeRef::parse("https://www.figma.com/board/B1/Jam?node-id=5-6").unwrap(),
            node(Some("B1"), "5:6")
        );
    }

    #[test]
    fn a_branch_link_uses_the_branch_key() {
        assert_eq!(
            NodeRef::parse("https://www.figma.com/design/Main1/branch/Br2/Name?node-id=3-4")
                .unwrap(),
            node(Some("Br2"), "3:4")
        );
    }

    #[test]
    fn a_bare_node_id_means_the_selection_in_the_open_file() {
        assert_eq!(NodeRef::parse("12:34").unwrap(), node(None, "12:34"));
        assert_eq!(NodeRef::parse(" 12-34 ").unwrap(), node(None, "12:34"));
    }

    #[test]
    fn anything_else_is_refused() {
        for bad in [
            "http://www.figma.com/design/K/x?node-id=1-2",
            "https://evil.com/design/K/x?node-id=1-2",
            "https://figma.com.evil.com/design/K/x?node-id=1-2",
            "https://www.figma.com/design/K/x",
            "https://www.figma.com/proto/K/x?node-id=1-2",
            "https://www.figma.com/design/K/x?node-id=a-b",
            "1",
            "abc",
            "",
        ] {
            assert!(NodeRef::parse(bad).is_err(), "{bad:?}");
        }
    }

    fn reply(result: Value) -> Reply {
        Reply {
            raw: String::new(),
            hash: String::new(),
            result,
        }
    }

    #[test]
    fn content_blocks_are_text_images_and_the_rest() {
        let r = reply(json!({ "content": [
            { "type": "text", "text": "<frame/>" },
            { "type": "image", "mimeType": "image/png", "data": "AAAA" },
            { "type": "resource", "uri": "x" },
        ]}));
        assert_eq!(
            r.content().unwrap(),
            [
                Content::Text("<frame/>".into()),
                Content::Image {
                    mime: "image/png".into(),
                    data: "AAAA".into()
                },
                Content::Other(json!({ "type": "resource", "uri": "x" }).to_string()),
            ]
        );
        assert_eq!(r.text().unwrap(), "<frame/>");
    }

    #[test]
    fn a_result_flagged_as_an_error_is_an_error_with_its_text() {
        let r = reply(
            json!({ "isError": true, "content": [{ "type": "text", "text": "no node 9:9" }] }),
        );
        assert_eq!(
            r.content().unwrap_err(),
            LinkError::Tool("no node 9:9".into())
        );
        assert_eq!(reply(json!({})).content().unwrap(), []);
    }
}
