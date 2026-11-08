//! A Playout control client for developing without the real application.
//!
//! It exposes only cue, take, clear, and output configuration. It sends an
//! engine intent (`NextOpportunity` or `Frame`) rather than a wall-clock time,
//! preventing a client from becoming a clock authority (invariants 5, 8, 9).

#![forbid(unsafe_code)]

use gx_contracts::auth::{Role, Scope};
use gx_contracts::{ContentHash, Revision, TakeId};
use gx_control_plane::intent::{ClearRequest, CueRequest, TakeAt, TakeRequest};
use gx_control_plane::message::{ClientRequest, EngineReply, OutputConfig};
use gx_control_plane::peer::EnginePeer;
use gx_control_transport::{Client, Token};
use std::net::SocketAddr;

#[derive(Debug)]
enum Error {
    Usage(String),
    Credential(String),
    Connect(String),
    Refused(String),
    Reply(String),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Usage(s)
            | Self::Credential(s)
            | Self::Connect(s)
            | Self::Refused(s)
            | Self::Reply(s) => f.write_str(s),
        }
    }
}
impl std::error::Error for Error {}

/// The scene a cue or take names: take id, revision and, when given, the
/// content hash it pins. A missing hash is sent as missing, so the engine
/// refuses it by name (`revisionUnpinned`, invariant 61).
#[derive(Debug)]
struct Pin {
    take_id: TakeId,
    revision: Revision,
    content_hash: Option<ContentHash>,
}

#[derive(Debug)]
enum Operation {
    Cue(Pin, TakeAt),
    Take(Pin, TakeAt),
    Clear(TakeAt),
    Output(OutputConfig),
}

fn main() {
    match parse(std::env::args().skip(1)).and_then(run) {
        Ok(()) => {}
        Err(Error::Usage(problem)) => {
            eprintln!("{problem}\n");
            usage();
            std::process::exit(2);
        }
        Err(error) => {
            eprintln!("gx-mock-playout: {error}");
            std::process::exit(1);
        }
    }
}

fn parse(
    args: impl IntoIterator<Item = String>,
) -> Result<(SocketAddr, Option<String>, Operation), Error> {
    let mut args = args.into_iter();
    let mut engine = None;
    let mut token = None;
    let mut op = None;
    let mut live = false;
    let mut accept_free_run = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--engine" => {
                engine = Some(
                    next(&mut args, "--engine")?
                        .parse()
                        .map_err(|_| Error::Usage("--engine needs host:port".into()))?,
                )
            }
            "--token" => token = Some(next(&mut args, "--token")?),
            "--frame" => {
                let frame = next(&mut args, "--frame")?
                    .parse()
                    .map_err(|_| Error::Usage("--frame needs an unsigned number".into()))?;
                // Bind at parse time so the flag may precede or follow the
                // operation; a take with a frame and a take without one are the
                // same request with a different scheduling choice.
                match &mut op {
                    Some(Operation::Cue(_, at))
                    | Some(Operation::Take(_, at))
                    | Some(Operation::Clear(at)) => *at = TakeAt::Frame { frame },
                    Some(Operation::Output(_)) => {
                        return Err(Error::Usage(
                            "--frame applies to cue, take and clear, not to an output".into(),
                        ))
                    }
                    None => {
                        return Err(Error::Usage(
                            "--frame must follow the operation it schedules".into(),
                        ))
                    }
                }
            }
            "--cue" => set(
                &mut op,
                Operation::Cue,
                parse_take(&next(&mut args, "--cue")?)?,
                TakeAt::NextOpportunity,
            )?,
            "--take" => set(
                &mut op,
                Operation::Take,
                parse_take(&next(&mut args, "--take")?)?,
                TakeAt::NextOpportunity,
            )?,
            "--clear" => {
                if op.is_some() {
                    return Err(Error::Usage("exactly one operation is permitted".into()));
                };
                op = Some(Operation::Clear(TakeAt::NextOpportunity));
            }
            "--configure-output" => {
                if op.is_some() {
                    return Err(Error::Usage("exactly one operation is permitted".into()));
                };
                op = Some(Operation::Output(OutputConfig {
                    adapter: next(&mut args, "--configure-output")?,
                    live,
                    accept_free_run,
                }));
            }
            "--live" => live = true,
            "--accept-free-run" => accept_free_run = true,
            "--help" | "-h" => return Err(Error::Usage(String::new())),
            unknown => return Err(Error::Usage(format!("unknown argument {unknown}"))),
        }
    }
    Ok((
        engine.ok_or_else(|| {
            Error::Usage("--engine is required; the mock never guesses a peer".into())
        })?,
        token,
        op.ok_or_else(|| Error::Usage("one operation is required".into()))?,
    ))
}
fn next(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, Error> {
    args.next()
        .ok_or_else(|| Error::Usage(format!("{flag} needs a value")))
}
/// `<id>:<revision>` or `<id>:<revision>:<sha256>`.
fn parse_take(spec: &str) -> Result<Pin, Error> {
    let (rest, last) = spec
        .rsplit_once(':')
        .ok_or_else(|| Error::Usage("scene must be <id>:<revision>[:<hash>]".into()))?;
    let is_hash = last.len() == 64 && last.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let (id, revision, content_hash) = if is_hash {
        let (id, revision) = rest
            .rsplit_once(':')
            .ok_or_else(|| Error::Usage("scene must be <id>:<revision>[:<hash>]".into()))?;
        (id, revision, Some(ContentHash(last.into())))
    } else {
        (rest, last, None)
    };
    Ok(Pin {
        take_id: TakeId(id.into()),
        revision: Revision(
            revision
                .parse()
                .map_err(|_| Error::Usage("revision must be unsigned".into()))?,
        ),
        content_hash,
    })
}
fn set(
    op: &mut Option<Operation>,
    build: fn(Pin, TakeAt) -> Operation,
    pin: Pin,
    at: TakeAt,
) -> Result<(), Error> {
    if op.is_some() {
        return Err(Error::Usage("exactly one operation is permitted".into()));
    };
    *op = Some(build(pin, at));
    Ok(())
}
fn run((engine, token, op): (SocketAddr, Option<String>, Operation)) -> Result<(), Error> {
    let mut client = match token {
        Some(raw) => Client::connect_with_token(
            engine,
            Token::mint(
                "mock-playout",
                Role::Playout,
                vec![
                    Scope::Cue,
                    Scope::Take,
                    Scope::Clear,
                    Scope::ConfigureOutput,
                ],
                raw,
            )
            .map_err(|e| Error::Credential(e.to_string()))?,
        )
        .map_err(|e| Error::Connect(e.to_string()))?,
        None => Client::connect(engine).map_err(|e| Error::Connect(e.to_string()))?,
    };
    let reply = match op {
        Operation::Cue(pin, at) => client.handle(ClientRequest::Cue(CueRequest {
            take_id: pin.take_id,
            revision: pin.revision,
            content_hash: pin.content_hash,
            at,
        })),
        Operation::Take(pin, at) => client.handle(ClientRequest::Take(TakeRequest {
            take_id: pin.take_id,
            revision: pin.revision,
            content_hash: pin.content_hash,
            at,
        })),
        Operation::Clear(at) => client.handle(ClientRequest::Clear(ClearRequest { at })),
        Operation::Output(config) => client.handle(ClientRequest::ConfigureOutput(config)),
    };
    match reply {
        EngineReply::Cued(c) => println!("cue committed at frame {}", c.frame),
        EngineReply::Taken(c) => println!("take committed at frame {}", c.frame),
        EngineReply::Cleared(c) => println!("clear committed at frame {}", c.frame),
        EngineReply::OutputConfigured { adapter, live } => {
            println!("output {adapter} configured (live: {live})")
        }
        // The code name first, so a script can act on the refusal without
        // parsing prose (invariant 17).
        EngineReply::Refused(r) => {
            return Err(Error::Refused(format!("refused [{}]: {r}", r.code_name())))
        }
        other => return Err(Error::Reply(format!("unexpected reply {other:?}"))),
    };
    Ok(())
}
fn usage() {
    eprintln!("gx-mock-playout --engine <host:port> [--token <token>] (--cue|--take <id:revision[:hash]>|--clear|--configure-output <adapter>) [--frame <n>] [--live] [--accept-free-run]\n\nCue, take, and clear default to NextOpportunity; no command accepts a time. A cue or take without the revision's content hash is refused by name.");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cue_defaults_to_next_opportunity() {
        let (_, _, op) =
            parse(["--engine", "127.0.0.1:4400", "--cue", "a:1"].map(str::to_string)).unwrap();
        assert!(matches!(
            op,
            Operation::Cue(
                Pin {
                    content_hash: None,
                    ..
                },
                TakeAt::NextOpportunity
            )
        ));
    }
    #[test]
    fn frame_is_the_only_explicit_scheduling_choice() {
        let (_, _, op) = parse(
            [
                "--engine",
                "127.0.0.1:4400",
                "--take",
                "a:1",
                "--frame",
                "42",
            ]
            .map(str::to_string),
        )
        .unwrap();
        assert!(matches!(
            op,
            Operation::Take(_, TakeAt::Frame { frame: 42 })
        ));
    }
    #[test]
    fn a_take_may_pin_the_content_hash() {
        let hash = "0123456789abcdef".repeat(4);
        let spec = format!("scene/a:3:{hash}");
        let (_, _, op) =
            parse(["--engine", "127.0.0.1:4400", "--take", &spec].map(str::to_string)).unwrap();
        assert!(matches!(
            &op,
            Operation::Take(Pin { take_id, revision: Revision(3), content_hash: Some(pinned) }, _)
                if take_id.0 == "scene/a" && pinned.0 == hash
        ));
    }
}
