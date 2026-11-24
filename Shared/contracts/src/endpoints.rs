//! Where the products listen, and the one policy that says whether they may
//! (build plan 2.21, ADR-0001 action 2, invariant 41).
//!
//! Three places used to know this separately: the control plane's bind module
//! (the ports and the rules), the asset plane (which bound its own socket and
//! asked nothing of anyone) and the MCP HTTP server (which hard-coded loopback
//! and accepted any port). They are all here now, in the lowest crate, so every
//! plane can ask the same question before it opens a socket.
//!
//! **One rule, said once.** [`check_listen`] answers whether a plane may listen
//! at an address, given the token it holds:
//!
//! - a reserved port is refused by name, whatever the plane;
//! - a token shorter than [`MINIMUM_TOKEN_BYTES`] is refused, not padded;
//! - loopback needs no token;
//! - off loopback, a plane that **verifies credentials** needs a token, and a
//!   plane that **verifies none** may not listen there at all, token or no
//!   token. A token configured on a plane that never checks it protects nothing
//!   and would only make the listener look protected. The asset plane and the
//!   MCP HTTP server are such planes today (rows 2.24 and 2.23 change that, and
//!   then [`Plane::authenticates`] changes with them).

use std::fmt;
use std::net::{IpAddr, SocketAddr};

/// The engine's control port (invariant 41).
pub const ENGINE_CONTROL_PORT: u16 = 4400;

/// The engine's asset-plane port when none is given: the control port plus one.
pub const ENGINE_ASSET_PORT: u16 = 4401;

/// Where a shell looks for the engine's control plane when nobody says.
pub const DEFAULT_CONTROL_ENDPOINT: &str = "127.0.0.1:4400";

/// Where the Editor publishes when nobody says.
pub const DEFAULT_ASSET_ENDPOINT: &str = "127.0.0.1:4401";

/// The shortest token a listener may be given.
pub const MINIMUM_TOKEN_BYTES: usize = 32;

/// Ports no GrapiX listener may take, and why.
pub const RESERVED_PORTS: &[(u16, &str)] = &[
    (4200, "belonged to the retired v2 daemon"),
    (4100, "project API"),
    (4300, "playout-control"),
];

/// The asset-plane port for a control port: the next one, if there is one.
pub const fn asset_port_for(control_port: u16) -> Option<u16> {
    control_port.checked_add(1)
}

/// The planes that listen. A plane is a logical channel, not an OSI layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plane {
    /// The engine's control plane: tokens verified once per connection.
    Control,
    /// The engine's asset plane: publishes and fetches of scene packages.
    Asset,
    /// An MCP server's HTTP transport.
    McpHttp,
}

impl Plane {
    /// What the plane is called in a refusal.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Control => "control plane",
            Self::Asset => "asset plane",
            Self::McpHttp => "MCP HTTP transport",
        }
    }

    /// Whether the plane verifies a credential on the connections it accepts, with the token
    /// this policy is given: the control plane, and the asset plane since 2.24 (it verifies the
    /// control plane's gx1 credential on every connection's first frame). The MCP HTTP transport verifies a credential
    /// on every request (2.23) with a secret of its own, but it is a local agent endpoint: it is
    /// never offered a network interface, so the policy treats it as a plane that cannot leave
    /// loopback.
    pub const fn authenticates(self) -> bool {
        matches!(self, Self::Control | Self::Asset)
    }

    /// Why a plane that is not given a token may listen on loopback only.
    pub const fn loopback_only_because(self) -> &'static str {
        match self {
            Self::Control | Self::Asset => "takes a token and may listen off loopback",
            Self::McpHttp => {
                "is a local agent endpoint: it verifies each request's credential, but it listens on loopback only and is never offered a network interface"
            }
        }
    }
}

/// Why a plane may not listen where it asked to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListenRefusal {
    /// The port is one no GrapiX listener may take.
    PortReserved { port: u16, reason: &'static str },
    /// The token is shorter than [`MINIMUM_TOKEN_BYTES`].
    TokenTooWeak { length: usize, minimum: usize },
    /// A plane that verifies credentials was asked to listen off loopback
    /// with none configured.
    NonLoopbackWithoutToken { plane: Plane, addr: SocketAddr },
    /// A plane that verifies no credential was asked to listen off loopback.
    PlaneCannotAuthenticate { plane: Plane, addr: SocketAddr },
}

impl fmt::Display for ListenRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PortReserved { port, reason } => write!(f, "port {port} is reserved: {reason}"),
            Self::TokenTooWeak { length, minimum } => {
                write!(f, "token is {length} bytes, minimum is {minimum}")
            }
            Self::NonLoopbackWithoutToken { plane, addr } => write!(
                f,
                "refusing to bind {addr}: a non-loopback {} requires a token",
                plane.name()
            ),
            Self::PlaneCannotAuthenticate { plane, addr } => write!(
                f,
                "refusing to bind {addr}: the {} {}",
                plane.name(),
                plane.loopback_only_because()
            ),
        }
    }
}

impl std::error::Error for ListenRefusal {}

/// Whether an address is the machine talking to itself.
pub fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback(),
    }
}

/// Whether `plane` may listen at `addr`, holding `token`. The one bind policy.
pub fn check_listen(
    plane: Plane,
    addr: SocketAddr,
    token: Option<&str>,
) -> Result<(), ListenRefusal> {
    if let Some((port, reason)) = RESERVED_PORTS.iter().find(|(port, _)| *port == addr.port()) {
        return Err(ListenRefusal::PortReserved {
            port: *port,
            reason,
        });
    }
    if let Some(token) = token {
        if token.len() < MINIMUM_TOKEN_BYTES {
            return Err(ListenRefusal::TokenTooWeak {
                length: token.len(),
                minimum: MINIMUM_TOKEN_BYTES,
            });
        }
    }
    if is_loopback(addr.ip()) {
        return Ok(());
    }
    if !plane.authenticates() {
        return Err(ListenRefusal::PlaneCannotAuthenticate { plane, addr });
    }
    if token.is_some() {
        Ok(())
    } else {
        Err(ListenRefusal::NonLoopbackWithoutToken { plane, addr })
    }
}

/// [`check_listen`] for a caller that binds a socket and reports `io::Error`: a
/// refusal is `PermissionDenied`, and its message names the plane first, so a
/// reserved port or a weak token is not an anonymous line in somebody's log.
pub fn check_listen_io(plane: Plane, addr: SocketAddr, token: Option<&str>) -> std::io::Result<()> {
    check_listen(plane, addr, token).map_err(|refusal| {
        std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("{}: {refusal}", plane.name()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = "0123456789abcdef0123456789abcdef";
    const PLANES: [Plane; 3] = [Plane::Control, Plane::Asset, Plane::McpHttp];

    fn addr(ip: &str, port: u16) -> SocketAddr {
        SocketAddr::new(ip.parse().unwrap(), port)
    }

    #[test]
    fn the_defaults_agree_with_the_ports() {
        assert_eq!(
            DEFAULT_CONTROL_ENDPOINT,
            format!("127.0.0.1:{ENGINE_CONTROL_PORT}")
        );
        assert_eq!(
            DEFAULT_ASSET_ENDPOINT,
            format!("127.0.0.1:{ENGINE_ASSET_PORT}")
        );
        assert_eq!(Some(ENGINE_ASSET_PORT), asset_port_for(ENGINE_CONTROL_PORT));
        assert_eq!(asset_port_for(u16::MAX), None);
        for port in [ENGINE_CONTROL_PORT, ENGINE_ASSET_PORT] {
            assert!(
                RESERVED_PORTS.iter().all(|(reserved, _)| *reserved != port),
                "the engine's own port {port} is reserved"
            );
        }
    }

    #[test]
    fn loopback_needs_no_token_on_any_plane() {
        for plane in PLANES {
            for ip in ["127.0.0.1", "127.9.9.9", "::1"] {
                assert_eq!(
                    check_listen(plane, addr(ip, 4400), None),
                    Ok(()),
                    "{plane:?} {ip}"
                );
            }
        }
    }

    #[test]
    fn a_plane_that_verifies_credentials_may_leave_loopback_with_a_token_and_not_without() {
        for ip in ["192.168.1.50", "10.0.0.4", "0.0.0.0", "::"] {
            let a = addr(ip, 4400);
            assert_eq!(check_listen(Plane::Control, a, Some(GOOD)), Ok(()), "{ip}");
            assert_eq!(check_listen(Plane::Asset, a, Some(GOOD)), Ok(()), "{ip}");
            assert_eq!(
                check_listen(Plane::Asset, a, None),
                Err(ListenRefusal::NonLoopbackWithoutToken {
                    plane: Plane::Asset,
                    addr: a
                }),
                "{ip}"
            );
            assert_eq!(
                check_listen(Plane::Control, a, None),
                Err(ListenRefusal::NonLoopbackWithoutToken {
                    plane: Plane::Control,
                    addr: a
                }),
                "{ip}"
            );
        }
    }

    #[test]
    fn a_plane_that_is_not_offered_the_network_may_not_leave_loopback_token_or_not() {
        for plane in [Plane::McpHttp] {
            for ip in ["192.168.1.50", "0.0.0.0", "::"] {
                let a = addr(ip, 4401);
                for token in [None, Some(GOOD)] {
                    assert_eq!(
                        check_listen(plane, a, token),
                        Err(ListenRefusal::PlaneCannotAuthenticate { plane, addr: a }),
                        "{plane:?} {ip} {token:?}"
                    );
                }
            }
        }
        let said = check_listen(Plane::McpHttp, addr("10.0.0.4", 4401), Some(GOOD))
            .unwrap_err()
            .to_string();
        assert!(
            said.contains("MCP HTTP transport") && said.contains("listens on loopback only"),
            "{said}"
        );
    }

    #[test]
    fn a_reserved_port_is_refused_by_name_on_every_plane_and_address() {
        for plane in PLANES {
            for (port, reason) in RESERVED_PORTS {
                assert_eq!(
                    check_listen(plane, addr("127.0.0.1", *port), None),
                    Err(ListenRefusal::PortReserved {
                        port: *port,
                        reason
                    }),
                    "{plane:?} {port}"
                );
            }
        }
    }

    #[test]
    fn a_short_token_is_refused_rather_than_padded() {
        for plane in PLANES {
            assert_eq!(
                check_listen(plane, addr("127.0.0.1", 4400), Some("secret")),
                Err(ListenRefusal::TokenTooWeak {
                    length: 6,
                    minimum: MINIMUM_TOKEN_BYTES
                }),
                "{plane:?}"
            );
        }
        assert!(check_listen(Plane::Control, addr("127.0.0.1", 4400), Some("")).is_err());
    }

    #[test]
    fn an_io_refusal_is_permission_denied_and_names_the_plane_first() {
        for plane in PLANES {
            for (a, token, because) in [
                (addr("127.0.0.1", 4100), None, "port 4100 is reserved"),
                (addr("127.0.0.1", 4400), Some("short"), "token is 5 bytes"),
            ] {
                let refused = check_listen_io(plane, a, token).unwrap_err();
                assert_eq!(refused.kind(), std::io::ErrorKind::PermissionDenied);
                let said = refused.to_string();
                assert!(
                    said.starts_with(plane.name()) && said.contains(because),
                    "{plane:?}: {said}"
                );
            }
            assert!(check_listen_io(plane, addr("127.0.0.1", 4400), None).is_ok());
        }
    }

    #[test]
    fn the_control_and_asset_planes_take_a_token_and_the_mcp_transport_is_local_only() {
        assert!(Plane::Control.authenticates());
        assert!(Plane::Asset.authenticates());
        assert!(!Plane::McpHttp.authenticates());
    }
}
