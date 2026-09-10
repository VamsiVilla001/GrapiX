//! Where the engine may listen, and on what terms (invariant 41).
//!
//! A loopback bind is reachable only by processes on the same machine, which
//! is the L0 case and needs no token. Anything else is reachable by the
//! network, and the control plane is the surface that can put pixels to air —
//! so it must not come up without authentication.
//!
//! **This is a refusal, never a warning.** A warning is a line in a log that
//! nobody reads until after the incident. The failure mode being prevented is
//! an engine quietly listening to a LAN with no credential, which is not
//! something an operator would discover by noticing.
//!
//! Kept as a pure policy function over an address so it is testable without
//! binding anything, and so the engine, the tests and any future L1 listener
//! cannot disagree about the rule.

use std::net::{IpAddr, SocketAddr};

/// Why a bind was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindRefusal {
    /// A network-reachable address with no token configured.
    NonLoopbackWithoutToken { addr: SocketAddr },
    /// A token was configured but is not usable.
    TokenTooWeak { length: usize, minimum: usize },
    /// The port belongs to something else (invariant 32).
    PortReserved { port: u16, reason: &'static str },
}

impl std::fmt::Display for BindRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BindRefusal::NonLoopbackWithoutToken { addr } => write!(
                f,
                "refusing to bind {addr}: a non-loopback control plane requires a token"
            ),
            BindRefusal::TokenTooWeak { length, minimum } => {
                write!(f, "token is {length} bytes, minimum is {minimum}")
            }
            BindRefusal::PortReserved { port, reason } => {
                write!(f, "port {port} is reserved: {reason}")
            }
        }
    }
}

impl std::error::Error for BindRefusal {}

/// Shortest token accepted. Not a security analysis — a floor, so that an
/// empty string or a placeholder cannot satisfy the check.
pub const MINIMUM_TOKEN_BYTES: usize = 32;

/// The engine's control-plane port (invariant 32).
pub const ENGINE_CONTROL_PORT: u16 = 4400;

/// Ports that must not be used, and why.
///
/// 4200 is burned: it belonged to a daemon that was retired, and reusing it
/// would let a stale client connect to something that is not what it expects.
const RESERVED: &[(u16, &str)] = &[
    (4200, "belonged to the retired v2 daemon"),
    (4100, "project API"),
    (4300, "playout-control"),
];

/// Decide whether the engine may listen here.
pub fn check_bind(addr: SocketAddr, token: Option<&str>) -> Result<(), BindRefusal> {
    if let Some((port, reason)) = RESERVED.iter().find(|(p, _)| *p == addr.port()) {
        return Err(BindRefusal::PortReserved {
            port: *port,
            reason,
        });
    }

    if let Some(token) = token {
        if token.len() < MINIMUM_TOKEN_BYTES {
            return Err(BindRefusal::TokenTooWeak {
                length: token.len(),
                minimum: MINIMUM_TOKEN_BYTES,
            });
        }
        // A token makes any address acceptable.
        return Ok(());
    }

    if is_loopback(addr.ip()) {
        Ok(())
    } else {
        Err(BindRefusal::NonLoopbackWithoutToken { addr })
    }
}

/// Whether an address is reachable only from this machine.
///
/// `0.0.0.0` and `::` are explicitly *not* loopback: they bind every
/// interface, which is the case this module exists to catch. Treating an
/// unspecified address as local is the mistake that turns the rule into
/// decoration.
fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn addr(ip: &str, port: u16) -> SocketAddr {
        SocketAddr::new(ip.parse().unwrap(), port)
    }

    const GOOD_TOKEN: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn loopback_needs_no_token() {
        assert!(check_bind(addr("127.0.0.1", ENGINE_CONTROL_PORT), None).is_ok());
        assert!(check_bind(addr("::1", ENGINE_CONTROL_PORT), None).is_ok());
    }

    #[test]
    fn a_network_address_without_a_token_is_refused() {
        let a = addr("192.168.1.50", ENGINE_CONTROL_PORT);
        assert_eq!(
            check_bind(a, None),
            Err(BindRefusal::NonLoopbackWithoutToken { addr: a })
        );
    }

    #[test]
    fn an_unspecified_address_is_not_loopback() {
        // The case that matters most: 0.0.0.0 binds every interface. If this
        // ever passes, the engine can come up exposed to a LAN with no
        // credential, and nothing would look wrong.
        for ip in ["0.0.0.0", "::"] {
            let a = addr(ip, ENGINE_CONTROL_PORT);
            assert!(
                check_bind(a, None).is_err(),
                "{ip} must not be treated as loopback"
            );
        }
        assert!(!is_loopback(IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
        assert!(!is_loopback(IpAddr::V6(Ipv6Addr::UNSPECIFIED)));
    }

    #[test]
    fn a_token_permits_a_network_bind() {
        assert!(check_bind(addr("10.0.0.4", ENGINE_CONTROL_PORT), Some(GOOD_TOKEN)).is_ok());
    }

    #[test]
    fn a_short_token_is_refused_rather_than_padded() {
        let err = check_bind(addr("10.0.0.4", ENGINE_CONTROL_PORT), Some("secret")).unwrap_err();
        assert_eq!(
            err,
            BindRefusal::TokenTooWeak {
                length: 6,
                minimum: MINIMUM_TOKEN_BYTES
            }
        );
        // An empty token is not "no token": passing Some("") is a
        // misconfiguration and must not silently fall through to the loopback
        // rule.
        assert!(check_bind(addr("127.0.0.1", ENGINE_CONTROL_PORT), Some("")).is_err());
    }

    #[test]
    fn burned_and_borrowed_ports_are_refused() {
        for (port, _) in RESERVED {
            let err = check_bind(addr("127.0.0.1", *port), None).unwrap_err();
            assert!(
                matches!(err, BindRefusal::PortReserved { .. }),
                "port {port} must be refused"
            );
        }
    }

    #[test]
    fn the_engine_port_is_the_one_the_invariant_names() {
        assert_eq!(ENGINE_CONTROL_PORT, 4400);
    }
}
