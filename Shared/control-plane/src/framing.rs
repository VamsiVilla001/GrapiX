//! The control plane's wire format.
//!
//! A length-prefixed JSON frame: four bytes of big-endian length, then that
//! many bytes of UTF-8 JSON. Pure functions over byte slices — no I/O, so the
//! format is testable without a socket and identical at L0 and L1
//! (invariant 16).
//!
//! Two properties are deliberate:
//!
//! - **The length is read before the body.** A stream framer that scans for a
//!   delimiter has to buffer unboundedly while it looks; this one knows how
//!   much to expect before it reads any of it.
//! - **Oversized frames are refused, not truncated.** Control messages are
//!   small by design (ADR-001). A frame claiming 4 GB is a bug or an attack,
//!   and either way the answer is to name the problem and close.

use serde::{de::DeserializeOwned, Serialize};

/// Bytes of length prefix.
pub const LENGTH_PREFIX: usize = 4;

/// Largest control frame accepted.
///
/// The control plane carries capability, cue, take, clear, patches and output
/// config. A megabyte is generous for all of them; assets travel on their own
/// plane precisely so this limit can stay small.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// What can go wrong turning bytes into a message, named rather than lumped
/// into one opaque error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FramingError {
    /// The frame declares more bytes than the plane accepts.
    FrameTooLarge { declared: usize, limit: usize },
    /// A frame declaring zero bytes carries no message.
    EmptyFrame,
    /// The body was not valid JSON for the expected type.
    Malformed { detail: String },
    /// A message too large to encode. Refused before it reaches the wire, so a
    /// peer never has to deal with a frame this side should not have sent.
    TooLargeToEncode { size: usize, limit: usize },
}

impl std::fmt::Display for FramingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FramingError::FrameTooLarge { declared, limit } => {
                write!(f, "frame declares {declared} bytes, limit is {limit}")
            }
            FramingError::EmptyFrame => f.write_str("frame declares zero bytes"),
            FramingError::Malformed { detail } => write!(f, "malformed frame: {detail}"),
            FramingError::TooLargeToEncode { size, limit } => {
                write!(f, "message is {size} bytes, limit is {limit}")
            }
        }
    }
}

impl std::error::Error for FramingError {}

/// Encode a message into a complete frame, prefix included.
pub fn encode<T: Serialize>(message: &T) -> Result<Vec<u8>, FramingError> {
    let body = serde_json::to_vec(message).map_err(|e| FramingError::Malformed {
        detail: e.to_string(),
    })?;
    if body.len() > MAX_FRAME_BYTES {
        return Err(FramingError::TooLargeToEncode {
            size: body.len(),
            limit: MAX_FRAME_BYTES,
        });
    }

    let mut frame = Vec::with_capacity(LENGTH_PREFIX + body.len());
    // `as u32` is safe: the length was just checked against MAX_FRAME_BYTES.
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

/// Read a frame's declared body length from its prefix.
pub fn decode_length(prefix: [u8; LENGTH_PREFIX]) -> Result<usize, FramingError> {
    let declared = u32::from_be_bytes(prefix) as usize;
    if declared == 0 {
        return Err(FramingError::EmptyFrame);
    }
    if declared > MAX_FRAME_BYTES {
        return Err(FramingError::FrameTooLarge {
            declared,
            limit: MAX_FRAME_BYTES,
        });
    }
    Ok(declared)
}

/// Decode a frame body into a message.
pub fn decode_body<T: DeserializeOwned>(body: &[u8]) -> Result<T, FramingError> {
    serde_json::from_slice(body).map_err(|e| FramingError::Malformed {
        detail: e.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::{ClearRequest, TakeAt};
    use crate::message::ClientRequest;

    fn request() -> ClientRequest {
        ClientRequest::Clear(ClearRequest {
            at: TakeAt::NextOpportunity,
        })
    }

    #[test]
    fn a_frame_round_trips() {
        let frame = encode(&request()).unwrap();
        let prefix: [u8; LENGTH_PREFIX] = frame[..LENGTH_PREFIX].try_into().unwrap();
        let len = decode_length(prefix).unwrap();
        assert_eq!(len, frame.len() - LENGTH_PREFIX);

        let back: ClientRequest = decode_body(&frame[LENGTH_PREFIX..]).unwrap();
        assert_eq!(back, request());
    }

    #[test]
    fn the_length_is_big_endian_and_precedes_the_body() {
        let frame = encode(&request()).unwrap();
        let body_len = frame.len() - LENGTH_PREFIX;
        assert_eq!(
            frame[..LENGTH_PREFIX],
            (body_len as u32).to_be_bytes(),
            "network byte order, so a capture is readable by anything"
        );
    }

    #[test]
    fn an_oversized_declaration_is_refused_by_name() {
        let prefix = (MAX_FRAME_BYTES as u32 + 1).to_be_bytes();
        assert_eq!(
            decode_length(prefix),
            Err(FramingError::FrameTooLarge {
                declared: MAX_FRAME_BYTES + 1,
                limit: MAX_FRAME_BYTES
            })
        );

        // The pathological case: a peer claiming almost 4 GB. The reader must
        // never allocate this to find out it was wrong.
        assert!(matches!(
            decode_length(u32::MAX.to_be_bytes()),
            Err(FramingError::FrameTooLarge { .. })
        ));
    }

    #[test]
    fn a_zero_length_frame_is_refused() {
        assert_eq!(decode_length([0, 0, 0, 0]), Err(FramingError::EmptyFrame));
    }

    #[test]
    fn a_frame_at_exactly_the_limit_is_accepted() {
        // Boundary: the limit is inclusive, so a frame of exactly MAX is fine
        // and MAX+1 is not.
        let prefix = (MAX_FRAME_BYTES as u32).to_be_bytes();
        assert_eq!(decode_length(prefix), Ok(MAX_FRAME_BYTES));
    }

    #[test]
    fn a_malformed_body_is_named_not_guessed_at() {
        let err = decode_body::<ClientRequest>(b"{not json").unwrap_err();
        assert!(matches!(err, FramingError::Malformed { .. }));

        // Valid JSON that is not this message is equally a refusal, not a
        // partially-applied default.
        let err = decode_body::<ClientRequest>(br#"{"request":"invented"}"#).unwrap_err();
        assert!(matches!(err, FramingError::Malformed { .. }));
    }

    #[test]
    fn every_request_variant_survives_the_wire() {
        use crate::intent::{CueRequest, TakeRequest};
        use crate::message::OutputConfig;
        use gx_contracts::{Revision, TakeId};

        let requests = vec![
            ClientRequest::Capability,
            ClientRequest::Status,
            ClientRequest::Cue(CueRequest {
                take_id: TakeId("t".into()),
                revision: Revision(1),
                at: TakeAt::NextOpportunity,
            }),
            ClientRequest::Take(TakeRequest {
                take_id: TakeId("t".into()),
                revision: Revision(9),
                at: TakeAt::Frame { frame: u64::MAX },
            }),
            ClientRequest::Clear(ClearRequest {
                at: TakeAt::NextOpportunity,
            }),
            ClientRequest::ConfigureOutput(OutputConfig {
                adapter: "decklink".into(),
                live: true,
                accept_free_run: false,
            }),
        ];

        for request in requests {
            let frame = encode(&request).unwrap();
            let back: ClientRequest = decode_body(&frame[LENGTH_PREFIX..]).unwrap();
            assert_eq!(back, request, "{request:?} did not survive the wire");
        }
    }
}
