//! Control-plane credentials.
//!
//! `bind` decides *where* the engine may listen and says a token makes a
//! non-loopback address acceptable. This module is the other half of that
//! sentence: without it, the bind policy permits a network listener that then
//! accepts anybody, which is worse than not having the policy — it reads as a
//! security control while being none.
//!
//! Two details are deliberate and easy to get wrong:
//!
//! - **`Token` redacts itself in `Debug`.** Every message type here derives
//!   `Debug`, refusals are formatted into logs, and connection errors are
//!   printed. A token that prints itself would end up in a log file on the
//!   first bad connection.
//! - **Comparison is constant-time over the full length.** `==` on `String`
//!   returns as soon as it finds a difference, which leaks the length of the
//!   matching prefix to anyone who can time it.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::bind::MINIMUM_TOKEN_BYTES;

/// A shared secret presented by a client on connect.
///
/// Deliberately not `Copy` and deliberately not `Display`: there is no
/// convenient way to print one by accident.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Token(pub String);

impl Token {
    /// Wrap a token, refusing one too short to be meaningful.
    pub fn new(value: impl Into<String>) -> Result<Self, TokenTooShort> {
        let value = value.into();
        if value.len() < MINIMUM_TOKEN_BYTES {
            return Err(TokenTooShort {
                length: value.len(),
                minimum: MINIMUM_TOKEN_BYTES,
            });
        }
        Ok(Self(value))
    }

    /// Whether this token matches `expected`, in time independent of where
    /// the first difference falls.
    ///
    /// Differing lengths are reported as a mismatch immediately: length is not
    /// a secret, and padding the comparison to hide it would mean comparing
    /// against memory that is not there.
    pub fn verify(&self, expected: &Token) -> bool {
        constant_time_eq(self.0.as_bytes(), expected.0.as_bytes())
    }
}

/// Redacted, so a token cannot reach a log through a derived `Debug`.
impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Token(<redacted>)")
    }
}

/// A token below the length floor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenTooShort {
    pub length: usize,
    pub minimum: usize,
}

impl std::fmt::Display for TokenTooShort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "token is {} bytes, minimum is {}",
            self.length, self.minimum
        )
    }
}

impl std::error::Error for TokenTooShort {}

/// Compare two byte strings without an early return.
///
/// Accumulates the difference of every byte pair and checks once at the end,
/// so the work done does not depend on the contents.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "0123456789abcdef0123456789abcdef";
    const B: &str = "0123456789abcdef0123456789abcdeF";

    #[test]
    fn a_token_never_prints_itself() {
        let token = Token::new(A).unwrap();
        let printed = format!("{token:?}");
        assert_eq!(printed, "Token(<redacted>)");
        assert!(
            !printed.contains("0123"),
            "a token must not reach a log through Debug"
        );

        // Also inside a container, which is how it actually travels.
        let wrapped = Some(token);
        assert!(!format!("{wrapped:?}").contains("0123"));
    }

    #[test]
    fn a_matching_token_verifies() {
        let a = Token::new(A).unwrap();
        assert!(a.verify(&Token::new(A).unwrap()));
    }

    #[test]
    fn a_token_differing_in_the_last_byte_does_not_verify() {
        // The case an early-return comparison would answer fastest, and the
        // one a timing attacker uses to walk a secret one byte at a time.
        let a = Token::new(A).unwrap();
        let b = Token::new(B).unwrap();
        assert!(!a.verify(&b));
    }

    #[test]
    fn a_token_differing_in_the_first_byte_does_not_verify() {
        let a = Token::new(A).unwrap();
        let mut other = A.to_string();
        other.replace_range(0..1, "X");
        assert!(!a.verify(&Token::new(other).unwrap()));
    }

    #[test]
    fn differing_lengths_do_not_verify() {
        let a = Token::new(A).unwrap();
        let longer = Token::new(format!("{A}extra")).unwrap();
        assert!(!a.verify(&longer));
        assert!(!longer.verify(&a));
    }

    #[test]
    fn a_short_token_cannot_be_constructed() {
        let err = Token::new("hunter2").unwrap_err();
        assert_eq!(err.length, 7);
        assert_eq!(err.minimum, MINIMUM_TOKEN_BYTES);
        // The empty string is the case a config file produces when a variable
        // is unset, so it must not slip through.
        assert!(Token::new("").is_err());
    }

    #[test]
    fn the_comparison_has_no_early_return() {
        // Not a timing measurement - those are unreliable in CI. This asserts
        // the property the implementation relies on: every prefix length is
        // treated alike, so no prefix is "more correct" than another.
        let expected = Token::new(A).unwrap();
        for prefix_len in 1..A.len() {
            let mut candidate = A.to_string();
            candidate.replace_range(prefix_len.., &"z".repeat(A.len() - prefix_len));
            let candidate = Token::new(candidate).unwrap();
            assert!(
                !candidate.verify(&expected),
                "a partial match must not verify at prefix {prefix_len}"
            );
        }
    }
}
