//! gx1 HMAC credentials for control connections.
//!
//! A credential is exactly `gx1.<payload>.<mac>`. The `gx1` prefix selects
//! HMAC-SHA256 before the parser decodes, reads or compares any later segment;
//! an unknown prefix is refused by name immediately. The payload deliberately
//! has no algorithm field. Letting data covered by a token select its verifier
//! recreates the JWT `alg: none` failure: an attacker would choose the rule
//! intended to reject them. `hmac` 0.12 (MIT/Apache-2.0) supplies RustCrypto's
//! HMAC-SHA256 implementation over the workspace's existing `sha2` crate.
//!
//! These credentials are verified once by the transport and retained as
//! connection state. They are never a property of an engine request, which
//! prevents a request path from accidentally missing an authorization check.

use std::fmt;

use gx_contracts::auth::{Role, Scope};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

const PREFIX: &str = "gx1";
const MAC_BYTES: usize = 32;
const MAC_HEX_LENGTH: usize = MAC_BYTES * 2;
type HmacSha256 = Hmac<Sha256>;

/// Authenticated identity retained by the connection after a credential check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claims {
    /// The configured human or service identity.
    pub subject: String,
    /// The product identity that bounds every scope.
    pub role: Role,
    /// The intentionally narrow set of authorities granted to this identity.
    pub scopes: Vec<Scope>,
}

impl Claims {
    /// Create claims, refusing an absent identity or a scope outside the role.
    pub fn new(
        subject: impl Into<String>,
        role: Role,
        scopes: Vec<Scope>,
    ) -> Result<Self, ClaimsError> {
        let subject = subject.into();
        if subject.is_empty() {
            return Err(ClaimsError::EmptySubject);
        }
        if let Some(scope) = scopes.iter().copied().find(|scope| !role.permits(*scope)) {
            return Err(ClaimsError::ScopeNotPermitted { role, scope });
        }
        Ok(Self {
            subject,
            role,
            scopes,
        })
    }
}

/// An opaque gx1 credential.
///
/// Deliberately not `Display`: credentials must not become log text by
/// convenience. `Debug` is explicitly redacted for the same reason.
#[derive(Clone, PartialEq, Eq)]
pub struct Token(String);

impl Token {
    /// Mint a gx1 HMAC-SHA256 credential from authenticated claims.
    pub fn mint(
        subject: impl Into<String>,
        role: Role,
        scopes: Vec<Scope>,
        secret: impl AsRef<[u8]>,
    ) -> Result<Self, TokenError> {
        let claims = Claims::new(subject, role, scopes).map_err(TokenError::InvalidClaims)?;
        let payload = Payload::from(&claims);
        let payload = serde_json::to_vec(&payload).expect("gx1 payload fields always serialize");
        let payload = encode_base64url(&payload);
        let signing_input = format!("{PREFIX}.{payload}");
        let mac = calculate_mac(signing_input.as_bytes(), secret.as_ref());
        Ok(Self(format!("{signing_input}.{}", encode_hex(&mac))))
    }

    /// Parse a credential structurally, rejecting an unknown algorithm prefix
    /// before examining its payload or MAC.
    pub fn parse(value: impl Into<String>) -> Result<Self, TokenError> {
        let value = value.into();
        let mut parts = value.split('.');
        let prefix = parts.next().unwrap_or_default();
        if prefix != PREFIX {
            return Err(TokenError::UnknownPrefix {
                prefix: prefix.to_owned(),
            });
        }

        let payload = parts.next().ok_or(TokenError::MalformedToken)?;
        let mac = parts.next().ok_or(TokenError::MalformedToken)?;
        if parts.next().is_some() || payload.is_empty() || mac.is_empty() {
            return Err(TokenError::MalformedToken);
        }

        // Structural checks are intentionally performed at parse time. This
        // proves payload roles/scopes are known closed values rather than a
        // later verifier treating an unknown value as no authority.
        let parsed_payload = decode_base64url(payload).ok_or(TokenError::InvalidPayloadEncoding)?;
        let payload: Payload =
            serde_json::from_slice(&parsed_payload).map_err(|_| TokenError::InvalidPayload)?;
        Claims::try_from(payload).map_err(TokenError::InvalidClaims)?;
        decode_mac(mac)?;

        Ok(Self(value))
    }

    /// Verify the credential's HMAC and return its authenticated claims.
    pub fn verify(&self, secret: impl AsRef<[u8]>) -> Result<Claims, TokenError> {
        let (_, payload, mac) = split_gx1(&self.0)?;
        let payload = decode_base64url(payload).ok_or(TokenError::InvalidPayloadEncoding)?;
        let payload: Payload =
            serde_json::from_slice(&payload).map_err(|_| TokenError::InvalidPayload)?;
        let claims = Claims::try_from(payload).map_err(TokenError::InvalidClaims)?;
        let actual = decode_mac(mac)?;
        let signing_input = &self.0[..self.0.len() - mac.len() - 1];
        let expected = calculate_mac(signing_input.as_bytes(), secret.as_ref());
        if !constant_time_mac_eq(&expected, &actual) {
            return Err(TokenError::MacMismatch);
        }
        Ok(claims)
    }

    /// The complete serialized credential.
    ///
    /// This is the wire form a caller holds after minting or parsing. It is
    /// the only place the text leaves the type, because a credential that can
    /// be printed can be logged (invariant 54), and the `Debug` redaction
    /// above exists precisely to keep this from happening by accident.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(<redacted>)")
    }
}

/// Why claims cannot safely be issued.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimsError {
    /// A token without a subject cannot name the connected principal.
    EmptySubject,
    /// A role attempted to claim authority belonging to another product.
    ScopeNotPermitted { role: Role, scope: Scope },
}

impl fmt::Display for ClaimsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptySubject => f.write_str("credential subject is empty"),
            Self::ScopeNotPermitted { role, scope } => {
                write!(f, "scope {scope:?} is not permitted for role {role:?}")
            }
        }
    }
}

impl std::error::Error for ClaimsError {}

/// Why gx1 parsing or verification refused a credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenError {
    /// The initial algorithm selector is not a version this transport supports.
    UnknownPrefix { prefix: String },
    /// The credential does not have exactly three nonempty dot-separated parts.
    MalformedToken,
    /// The payload segment is not canonical gx1 base64url data.
    InvalidPayloadEncoding,
    /// The payload is not the fixed gx1 claim shape.
    InvalidPayload,
    /// The payload's named role or scopes violate product ownership.
    InvalidClaims(ClaimsError),
    /// The MAC segment has a length other than HMAC-SHA256's 32 bytes.
    WrongMacLength { actual: usize, expected: usize },
    /// The MAC segment is not lowercase hexadecimal.
    InvalidMacEncoding,
    /// The full-length constant-time MAC comparison found a difference.
    MacMismatch,
}

impl fmt::Display for TokenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownPrefix { prefix } => write!(f, "unsupported token prefix {prefix:?}"),
            Self::MalformedToken => f.write_str("malformed gx1 token"),
            Self::InvalidPayloadEncoding => f.write_str("gx1 payload is not base64url"),
            Self::InvalidPayload => f.write_str("gx1 payload has an invalid shape"),
            Self::InvalidClaims(error) => write!(f, "invalid gx1 claims: {error}"),
            Self::WrongMacLength { actual, expected } => {
                write!(f, "gx1 MAC is {actual} bytes, expected {expected}")
            }
            Self::InvalidMacEncoding => f.write_str("gx1 MAC is not lowercase hexadecimal"),
            Self::MacMismatch => f.write_str("gx1 MAC does not verify"),
        }
    }
}

impl std::error::Error for TokenError {}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Payload {
    subject: String,
    role: Role,
    scopes: Vec<Scope>,
}

impl From<&Claims> for Payload {
    fn from(value: &Claims) -> Self {
        Self {
            subject: value.subject.clone(),
            role: value.role,
            scopes: value.scopes.clone(),
        }
    }
}

impl TryFrom<Payload> for Claims {
    type Error = ClaimsError;

    fn try_from(value: Payload) -> Result<Self, Self::Error> {
        Self::new(value.subject, value.role, value.scopes)
    }
}

fn split_gx1(value: &str) -> Result<(&str, &str, &str), TokenError> {
    let mut parts = value.split('.');
    let prefix = parts.next().unwrap_or_default();
    if prefix != PREFIX {
        return Err(TokenError::UnknownPrefix {
            prefix: prefix.to_owned(),
        });
    }
    let payload = parts.next().ok_or(TokenError::MalformedToken)?;
    let mac = parts.next().ok_or(TokenError::MalformedToken)?;
    if parts.next().is_some() || payload.is_empty() || mac.is_empty() {
        return Err(TokenError::MalformedToken);
    }
    Ok((prefix, payload, mac))
}

fn calculate_mac(signing_input: &[u8], secret: &[u8]) -> [u8; MAC_BYTES] {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts arbitrary key lengths");
    mac.update(signing_input);
    mac.finalize().into_bytes().into()
}

/// Compare every MAC byte before deciding. Length has already been checked by
/// `decode_mac`, so this cannot return based on a differing prefix or length.
fn constant_time_mac_eq(expected: &[u8; MAC_BYTES], actual: &[u8; MAC_BYTES]) -> bool {
    let mut difference = 0u8;
    for (expected, actual) in expected.iter().zip(actual) {
        difference |= expected ^ actual;
    }
    difference == 0
}

fn decode_mac(value: &str) -> Result<[u8; MAC_BYTES], TokenError> {
    if value.len() != MAC_HEX_LENGTH {
        return Err(TokenError::WrongMacLength {
            actual: value.len() / 2,
            expected: MAC_BYTES,
        });
    }
    let mut result = [0u8; MAC_BYTES];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        result[index] = (hex_nibble(pair[0]).ok_or(TokenError::InvalidMacEncoding)? << 4)
            | hex_nibble(pair[1]).ok_or(TokenError::InvalidMacEncoding)?;
    }
    Ok(result)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(DIGITS[(byte >> 4) as usize] as char);
        encoded.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn encode_base64url(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut encoded = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let word = u32::from(chunk[0]) << 16
            | u32::from(*chunk.get(1).unwrap_or(&0)) << 8
            | u32::from(*chunk.get(2).unwrap_or(&0));
        encoded.push(TABLE[(word >> 18) as usize & 0x3f] as char);
        encoded.push(TABLE[(word >> 12) as usize & 0x3f] as char);
        if chunk.len() > 1 {
            encoded.push(TABLE[(word >> 6) as usize & 0x3f] as char);
        }
        if chunk.len() > 2 {
            encoded.push(TABLE[word as usize & 0x3f] as char);
        }
    }
    encoded
}

fn decode_base64url(value: &str) -> Option<Vec<u8>> {
    if value.len() % 4 == 1 {
        return None;
    }
    let mut decoded = Vec::with_capacity(value.len() * 3 / 4);
    let bytes = value.as_bytes();
    for chunk in bytes.chunks(4) {
        let first = base64url_value(chunk[0])?;
        let second = base64url_value(*chunk.get(1)?)?;
        let third = match chunk.get(2) {
            Some(byte) => Some(base64url_value(*byte)?),
            None => None,
        };
        let fourth = match chunk.get(3) {
            Some(byte) => Some(base64url_value(*byte)?),
            None => None,
        };
        if third.is_none() && fourth.is_some() {
            return None;
        }
        let word = u32::from(first) << 18
            | u32::from(second) << 12
            | u32::from(third.unwrap_or(0)) << 6
            | u32::from(fourth.unwrap_or(0));
        decoded.push((word >> 16) as u8);
        if third.is_some() {
            decoded.push((word >> 8) as u8);
        }
        if fourth.is_some() {
            decoded.push(word as u8);
        }
    }
    Some(decoded)
}

fn base64url_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "0123456789abcdef0123456789abcdef";

    fn playout_token() -> Token {
        Token::mint(
            "playout-console",
            Role::Playout,
            vec![
                Scope::Cue,
                Scope::Take,
                Scope::Clear,
                Scope::ConfigureOutput,
            ],
            SECRET,
        )
        .unwrap()
    }

    #[test]
    fn gx1_prefix_fixes_the_algorithm_before_payload_or_mac_are_read() {
        for hostile in [
            "gx0.not-base64.not-hex",
            "none.not-base64.not-hex",
            ".not-base64.not-hex",
        ] {
            assert!(
                matches!(Token::parse(hostile), Err(TokenError::UnknownPrefix { .. })),
                "unknown prefix must refuse before later segments: {hostile}"
            );
        }
    }

    #[test]
    fn an_algorithm_field_in_the_payload_is_refused() {
        let payload = encode_base64url(
            br#"{"subject":"x","role":"playout","scopes":["take"],"algorithm":"none"}"#,
        );
        let token = format!("gx1.{payload}.{}", "00".repeat(MAC_BYTES));
        assert!(matches!(
            Token::parse(token),
            Err(TokenError::InvalidPayload)
        ));
    }

    #[test]
    fn a_minted_token_parses_and_verifies_its_claims() {
        let token = playout_token();
        let parsed = Token::parse(token.as_str()).unwrap();
        assert_eq!(
            parsed.verify(SECRET).unwrap(),
            Claims::new(
                "playout-console",
                Role::Playout,
                vec![
                    Scope::Cue,
                    Scope::Take,
                    Scope::Clear,
                    Scope::ConfigureOutput
                ],
            )
            .unwrap()
        );
    }

    #[test]
    fn payload_tampering_is_detected() {
        // Tamper where the payload stays structurally valid — a real attacker
        // changes a claim, not a byte of base64. The parser must accept the
        // shape so the verifier can reject the signature.
        let token = playout_token();
        let (prefix, payload, mac) = split_gx1(token.as_str()).unwrap();
        let decoded = decode_base64url(payload).unwrap();
        let mut claims: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
        claims["subject"] = serde_json::json!("editor-not-playout");
        let tampered_payload = encode_base64url(&serde_json::to_vec(&claims).unwrap());
        let tampered = Token::parse(format!("{prefix}.{tampered_payload}.{mac}")).unwrap();
        assert!(matches!(
            tampered.verify(SECRET),
            Err(TokenError::MacMismatch)
        ));
    }

    #[test]
    fn mac_tampering_is_detected() {
        let token = playout_token();
        let mut token = token.as_str().to_owned();
        token.pop();
        token.push('0');
        let tampered = Token::parse(token).unwrap();
        assert!(matches!(
            tampered.verify(SECRET),
            Err(TokenError::MacMismatch)
        ));
    }

    #[test]
    fn a_wrong_length_mac_is_refused_before_comparison() {
        let token = playout_token();
        let truncated = token
            .as_str()
            .rsplit_once('.')
            .map(|(head, _)| format!("{head}.00"))
            .unwrap();
        assert!(matches!(
            Token::parse(truncated),
            Err(TokenError::WrongMacLength {
                actual: 1,
                expected: MAC_BYTES
            })
        ));
    }

    #[test]
    fn a_token_never_prints_its_credential() {
        let token = playout_token();
        assert_eq!(format!("{token:?}"), "Token(<redacted>)");
        assert!(!format!("{token:?}").contains("gx1."));
    }

    #[test]
    fn the_mac_comparison_has_no_early_return() {
        let expected = calculate_mac(b"message", SECRET.as_bytes());
        for prefix_len in 0..MAC_BYTES {
            let mut actual = expected;
            for byte in &mut actual[prefix_len..] {
                *byte ^= 0xff;
            }
            assert!(
                !constant_time_mac_eq(&expected, &actual),
                "partial match at {prefix_len} verified"
            );
        }
    }

    #[test]
    fn unknown_roles_and_scopes_refuse_instead_of_becoming_empty_permissions() {
        let unknown_role =
            encode_base64url(br#"{"subject":"x","role":"director","scopes":["take"]}"#);
        let unknown_scope =
            encode_base64url(br#"{"subject":"x","role":"playout","scopes":["destroy"]}"#);
        for payload in [unknown_role, unknown_scope] {
            let token = format!("gx1.{payload}.{}", "00".repeat(MAC_BYTES));
            assert!(matches!(
                Token::parse(token),
                Err(TokenError::InvalidPayload)
            ));
        }
    }
}
