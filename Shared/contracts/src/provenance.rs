//! Asset provenance and licence fields (build plan 11.39).
//!
//! Every asset record a project holds carries one [`AssetProvenance`]. It
//! answers what a broadcaster is asked about any graphic that went to air:
//! who or what made it, through which tool, supplied by whom, under which
//! licence, and who approved it. Later steps act on it: 13.8 refuses an asset
//! whose licence class a show profile forbids and lists every model-origin
//! asset in a show, and 16.10 refuses a generator whose licence class is
//! unset. The schema exists now, before anything generative does.
//!
//! Every field may be empty. A human-made asset legitimately leaves most of
//! them unset, and a record upgraded from a pre-11.39 project starts empty:
//! nothing is inferred for it, because a guessed origin or licence would be a
//! claim nobody made (invariant 18).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ContentHash;

/// Who or what produced an asset's content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AssetOrigin {
    /// A person made it, including a file a person brought into the project.
    Human,
    /// A deterministic tool derived it from other inputs: a conversion, an
    /// export or a render.
    Tool,
    /// A generative model produced it.
    Model,
}

/// The terms an asset may be used under, as a class a show profile can test
/// (13.8) rather than free licence text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum LicenseClass {
    /// Made by or for the production, which holds the rights.
    Owned,
    /// Third-party, licensed for commercial broadcast.
    Commercial,
    /// An open licence that permits commercial use: OFL, CC0, CC BY,
    /// Apache-2.0, MIT.
    Permissive,
    /// GPL-class: obligations attach when it is redistributed.
    Copyleft,
    /// Licensed for non-commercial use only, such as CC BY-NC.
    NonCommercial,
    /// Licensed for editorial or news use only.
    Editorial,
    /// Limited by territory, term or medium.
    Restricted,
}

/// The tool, or for model origin the model, that made or imported the bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceTool {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub version: Option<String>,
}

/// A named person's approval of an asset for use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AssetApproval {
    /// The approving user, as the authorization layer names them (2.9).
    pub user: String,
    /// When they approved, as an RFC 3339 UTC timestamp. Authoring metadata
    /// only: nothing on the render path reads it (invariant 8).
    pub at: String,
}

/// Where an asset's bytes came from and under what terms.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AssetProvenance {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub origin: Option<AssetOrigin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tool: Option<ProvenanceTool>,
    /// Who supplied the bytes: a font service, a stock library, a model
    /// vendor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub license_class: Option<LicenseClass>,
    /// SHA-256 of the prompt a model was given. The prompt text is not
    /// stored with the asset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prompt_hash: Option<ContentHash>,
    /// What the asset was made or fetched from: file names, URLs, the content
    /// hashes of input assets. Always written, so the field is visible in a
    /// saved project even when it is empty.
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub approval: Option<AssetApproval>,
    /// An attached C2PA manifest: a project-relative path or a URI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub c2pa_manifest: Option<String>,
}
