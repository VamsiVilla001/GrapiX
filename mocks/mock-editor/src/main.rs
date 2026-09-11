//! An Editor authoring client for developing without the real application.
//!
//! It creates or reads a `SceneDocument` and publishes that complete document
//! over the restartable asset-plane endpoint. It has no Program or output
//! command at all, preventing mutable authoring content from acquiring Playout
//! authority (invariants 4 and 7).

#![forbid(unsafe_code)]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;

use gx_asset_plane::{PublishRefusal, PublishReply, PublishRequest};
use gx_contracts::scene::{SceneCanvas, SceneDocument, SceneTimeline};
use gx_contracts::RationalRate;

#[derive(Debug)]
enum EditorError {
    Usage(String),
    ReadScene(String),
    InvalidScene(String),
    Connect(String),
    PublishRefused(String),
    Protocol(String),
}

impl std::fmt::Display for EditorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Usage(problem) => write!(f, "{problem}"),
            Self::ReadScene(problem) => write!(f, "cannot read authored scene: {problem}"),
            Self::InvalidScene(problem) => write!(f, "authored scene is invalid: {problem}"),
            Self::Connect(problem) => write!(f, "cannot reach mock engine asset plane: {problem}"),
            Self::PublishRefused(problem) => write!(f, "engine refused publication: {problem}"),
            Self::Protocol(problem) => write!(f, "asset-plane protocol failed: {problem}"),
        }
    }
}

impl std::error::Error for EditorError {}

fn main() {
    match parse(std::env::args().skip(1)).and_then(publish) {
        Ok(()) => {}
        Err(EditorError::Usage(problem)) => {
            eprintln!("{problem}\n");
            usage();
            std::process::exit(2);
        }
        Err(error) => {
            eprintln!("gx-mock-editor: {error}");
            std::process::exit(1);
        }
    }
}

fn parse(
    args: impl IntoIterator<Item = String>,
) -> Result<(SocketAddr, SceneDocument), EditorError> {
    let mut args = args.into_iter();
    let mut engine = None;
    let mut source = None;
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--asset-engine" => {
                engine = Some(next(&mut args, "--asset-engine")?.parse().map_err(|_| {
                    EditorError::Usage(
                        "--asset-engine needs a socket address such as 127.0.0.1:4401".into(),
                    )
                })?)
            }
            "--scene" => {
                source = Some(SceneSource::File(PathBuf::from(next(
                    &mut args, "--scene",
                )?)))
            }
            "--new" => source = Some(SceneSource::New(next(&mut args, "--new")?)),
            "--help" | "-h" => return Err(EditorError::Usage(String::new())),
            unknown => return Err(EditorError::Usage(format!("unknown argument {unknown}"))),
        }
    }
    let engine = engine.ok_or_else(|| {
        EditorError::Usage("--asset-engine is required; the editor never guesses its peer".into())
    })?;
    let scene = match source.ok_or_else(|| {
        EditorError::Usage("one authoring input (--scene or --new) is required".into())
    })? {
        SceneSource::File(path) => serde_json::from_slice(
            &std::fs::read(path).map_err(|error| EditorError::ReadScene(error.to_string()))?,
        )
        .map_err(|error| EditorError::InvalidScene(error.to_string()))?,
        SceneSource::New(specification) => new_scene(&specification)?,
    };
    Ok((engine, scene))
}

enum SceneSource {
    File(PathBuf),
    New(String),
}

fn next(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, EditorError> {
    args.next()
        .ok_or_else(|| EditorError::Usage(format!("{flag} needs a value")))
}

fn new_scene(specification: &str) -> Result<SceneDocument, EditorError> {
    let (id, name) = specification
        .split_once(':')
        .ok_or_else(|| EditorError::Usage("--new needs <id>:<name>".into()))?;
    if id.is_empty() || name.is_empty() {
        return Err(EditorError::Usage(
            "a new scene needs both a non-empty id and name".into(),
        ));
    }
    Ok(SceneDocument {
        id: id.into(),
        name: name.into(),
        version: 1,
        revision: None,
        canvas: SceneCanvas {
            width: 1920,
            height: 1080,
            frame_rate: RationalRate::P50,
        },
        timeline: SceneTimeline::default(),
        data_context: Default::default(),
        assets: Vec::new(),
        fonts: Vec::new(),
        materials: Vec::new(),
        objects: Vec::new(),
    })
}

fn publish((engine, scene): (SocketAddr, SceneDocument)) -> Result<(), EditorError> {
    let request = serde_json::to_vec(&PublishRequest { scene })
        .map_err(|error| EditorError::Protocol(error.to_string()))?;
    let mut stream =
        TcpStream::connect(engine).map_err(|error| EditorError::Connect(error.to_string()))?;
    stream
        .write_all(&(request.len() as u32).to_be_bytes())
        .and_then(|_| stream.write_all(&request))
        .and_then(|_| stream.flush())
        .map_err(|error| EditorError::Protocol(error.to_string()))?;
    let mut prefix = [0_u8; 4];
    stream
        .read_exact(&mut prefix)
        .map_err(|error| EditorError::Protocol(error.to_string()))?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length > 64 * 1024 * 1024 {
        return Err(EditorError::Protocol(format!(
            "reply frame is {length} bytes"
        )));
    }
    let mut bytes = vec![0; length];
    stream
        .read_exact(&mut bytes)
        .map_err(|error| EditorError::Protocol(error.to_string()))?;
    match serde_json::from_slice(&bytes)
        .map_err(|error| EditorError::Protocol(error.to_string()))?
    {
        PublishReply::Published { take_id, revision } => {
            println!("published {} revision {}", take_id.0, revision.0)
        }
        PublishReply::Refused(PublishRefusal::InvalidSceneDocument { detail }) => {
            return Err(EditorError::PublishRefused(detail))
        }
    }
    Ok(())
}

fn usage() {
    eprintln!("gx-mock-editor --asset-engine <host:port> (--scene <document.json> | --new <id:name>)\n\nPublishes complete authoring content over the mock engine's asset-plane endpoint. This program has no cue, take, clear, Program, or output command.");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_scene_is_complete_authoring_content() {
        let scene = new_scene("lower-third:Lower Third").unwrap();
        assert_eq!(scene.id, "lower-third");
        assert_eq!(scene.canvas.frame_rate, RationalRate::P50);
    }

    #[test]
    fn the_editor_requires_an_asset_plane_peer() {
        let error = parse(["--new", "scene:Scene"].map(str::to_string)).unwrap_err();
        assert!(matches!(error, EditorError::Usage(_)));
    }
}
