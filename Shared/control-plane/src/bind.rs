//! Where the engine may listen, and on what terms (invariant 41).
//!
//! Network endpoints need a token unless they are loopback. A local endpoint
//! needs no token because its OS access boundary is stricter: Unix sockets are
//! created mode `0600` inside an owner-only directory, while Windows named
//! pipes receive an owner-only security descriptor. The policy is deliberately
//! here, before either listener exists, so a mock and the engine cannot disagree
//! about which unauthenticated endpoints are safe (invariants 27 and 52).

use std::io::{self, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};

/// A control-plane endpoint. `Local` is a Unix socket path on Unix and a full
/// `\\.\pipe\…` named-pipe path on Windows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Endpoint {
    Tcp(SocketAddr),
    Local(PathBuf),
}

/// A listener opened by the control-plane bind policy.
pub enum ControlListener {
    Tcp(TcpListener),
    #[cfg(windows)]
    Local(interprocess::local_socket::Listener),
    #[cfg(unix)]
    Local(UnixSocketListener),
}

/// A connected stream accepted or opened through an [`Endpoint`].
pub enum ControlStream {
    Tcp(TcpStream),
    #[cfg(windows)]
    Local(interprocess::local_socket::Stream),
    #[cfg(unix)]
    Local(UnixStream),
}

/// The split receive half used by a client read loop.
pub enum ControlReadHalf {
    Tcp(TcpStream),
    #[cfg(windows)]
    Local(interprocess::local_socket::RecvHalf),
    #[cfg(unix)]
    Local(UnixStream),
}

/// The split send half used by a client request path.
pub enum ControlWriteHalf {
    Tcp(TcpStream),
    #[cfg(windows)]
    Local(interprocess::local_socket::SendHalf),
    #[cfg(unix)]
    Local(UnixStream),
}

impl ControlListener {
    pub fn accept(&self) -> io::Result<ControlStream> {
        match self {
            Self::Tcp(listener) => listener
                .accept()
                .map(|(stream, _)| ControlStream::Tcp(stream)),
            #[cfg(windows)]
            Self::Local(listener) => {
                use interprocess::local_socket::traits::Listener as _;
                listener.accept().map(ControlStream::Local)
            }
            #[cfg(unix)]
            Self::Local(listener) => listener
                .accept()
                .map(|(stream, _)| ControlStream::Local(stream)),
        }
    }
}

impl ControlStream {
    /// TCP alone benefits from Nagle suppression. Local IPC has no TCP packet
    /// coalescing to disable, so treating it as TCP would be a false setting.
    pub fn set_low_latency(&self) -> io::Result<()> {
        match self {
            Self::Tcp(stream) => stream.set_nodelay(true),
            #[cfg(windows)]
            Self::Local(_) => Ok(()),
            #[cfg(unix)]
            Self::Local(_) => Ok(()),
        }
    }

    pub fn split(self) -> io::Result<(ControlReadHalf, ControlWriteHalf)> {
        match self {
            Self::Tcp(stream) => Ok((
                ControlReadHalf::Tcp(stream.try_clone()?),
                ControlWriteHalf::Tcp(stream),
            )),
            #[cfg(windows)]
            Self::Local(stream) => {
                use interprocess::local_socket::traits::Stream as _;
                let (reader, writer) = stream.split();
                Ok((
                    ControlReadHalf::Local(reader),
                    ControlWriteHalf::Local(writer),
                ))
            }
            #[cfg(unix)]
            Self::Local(stream) => Ok((
                ControlReadHalf::Local(stream.try_clone()?),
                ControlWriteHalf::Local(stream),
            )),
        }
    }
}

macro_rules! impl_read {
    ($type:ty) => {
        impl Read for $type {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                match self {
                    Self::Tcp(stream) => stream.read(buf),
                    #[cfg(windows)]
                    Self::Local(stream) => stream.read(buf),
                    #[cfg(unix)]
                    Self::Local(stream) => stream.read(buf),
                }
            }
        }
    };
}

macro_rules! impl_write {
    ($type:ty) => {
        impl Write for $type {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                match self {
                    Self::Tcp(stream) => stream.write(buf),
                    #[cfg(windows)]
                    Self::Local(stream) => stream.write(buf),
                    #[cfg(unix)]
                    Self::Local(stream) => stream.write(buf),
                }
            }
            fn flush(&mut self) -> io::Result<()> {
                match self {
                    Self::Tcp(stream) => stream.flush(),
                    #[cfg(windows)]
                    Self::Local(stream) => stream.flush(),
                    #[cfg(unix)]
                    Self::Local(stream) => stream.flush(),
                }
            }
        }
    };
}

impl_read!(ControlStream);
impl_write!(ControlStream);
impl_read!(ControlReadHalf);
impl_write!(ControlWriteHalf);

/// Bind a TCP control-plane listener, after checking the address against the
/// policy. Existing callers retain this entry point while endpoint-aware code
/// uses [`bind_endpoint`].
pub fn bind_listener(addr: SocketAddr, token: Option<&str>) -> Result<TcpListener, BindRefusal> {
    match bind_endpoint(&Endpoint::Tcp(addr), token)? {
        ControlListener::Tcp(listener) => Ok(listener),
        #[cfg(any(windows, unix))]
        ControlListener::Local(_) => unreachable!("a TCP endpoint cannot bind a local listener"),
    }
}

/// Bind a control-plane endpoint after policy approval.
pub fn bind_endpoint(
    endpoint: &Endpoint,
    token: Option<&str>,
) -> Result<ControlListener, BindRefusal> {
    check_endpoint(endpoint, token)?;
    match endpoint {
        Endpoint::Tcp(addr) => platform_bind(*addr).map(ControlListener::Tcp),
        Endpoint::Local(path) => bind_local(path),
    }
}

/// Connect to an endpoint selected by the caller. This never substitutes TCP
/// for local IPC: a local transport failure remains the named failure it is.
pub fn connect_endpoint(endpoint: &Endpoint) -> io::Result<ControlStream> {
    match endpoint {
        Endpoint::Tcp(addr) => TcpStream::connect(addr).map(ControlStream::Tcp),
        Endpoint::Local(path) => connect_local(path),
    }
}

#[cfg(windows)]
fn bind_local(path: &Path) -> Result<ControlListener, BindRefusal> {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    use interprocess::os::windows::{
        local_socket::ListenerOptionsExt, security_descriptor::SecurityDescriptor,
    };

    // Owner Rights binds this pipe to the account that created it. A permissive
    // inherited DACL would make a tokenless L0 pipe callable by another local
    // account, defeating the local-only policy above.
    let sddl = widestring::U16CString::from_str("D:P(A;;GA;;;OW)")
        .expect("the fixed owner-only SDDL contains no NUL");
    let descriptor = SecurityDescriptor::deserialize(sddl.as_ucstr()).map_err(BindRefusal::Io)?;
    let name = path
        .to_fs_name::<GenericFilePath>()
        .map_err(BindRefusal::Io)?;
    ListenerOptions::new()
        .name(name)
        .security_descriptor(descriptor)
        .create_sync()
        .map(ControlListener::Local)
        .map_err(BindRefusal::Io)
}

#[cfg(windows)]
fn connect_local(path: &Path) -> io::Result<ControlStream> {
    use interprocess::local_socket::{prelude::*, GenericFilePath, Stream};
    path.to_fs_name::<GenericFilePath>()
        .and_then(Stream::connect)
        .map(ControlStream::Local)
}

#[cfg(unix)]
struct UnixSocketListener {
    listener: UnixListener,
    path: PathBuf,
}

#[cfg(unix)]
impl UnixSocketListener {
    fn accept(&self) -> io::Result<(UnixStream, std::os::unix::net::SocketAddr)> {
        self.listener.accept()
    }
}

#[cfg(unix)]
impl Drop for UnixSocketListener {
    fn drop(&mut self) {
        // The path was created only after the private-parent policy accepted it.
        // Checking that it is still a socket avoids deleting a replacement file
        // if an operator has repaired the directory while the server was down.
        if std::fs::symlink_metadata(&self.path)
            .map(|m| m.file_type().is_socket())
            .unwrap_or(false)
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(unix)]
fn bind_local(path: &Path) -> Result<ControlListener, BindRefusal> {
    match UnixListener::bind(path) {
        Ok(listener) => secure_unix_listener(listener, path),
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => match UnixStream::connect(path) {
            Ok(_) => Err(BindRefusal::LocalEndpointOccupied {
                path: path.to_path_buf(),
            }),
            Err(connect_error) if connect_error.kind() == io::ErrorKind::ConnectionRefused => {
                let metadata = std::fs::symlink_metadata(path).map_err(BindRefusal::Io)?;
                if !metadata.file_type().is_socket() {
                    return Err(BindRefusal::StaleLocalEndpointNotSocket {
                        path: path.to_path_buf(),
                    });
                }
                // A refused connect proves this socket has no listener. We only
                // remove that proven corpse, never whatever merely occupies the path.
                std::fs::remove_file(path).map_err(BindRefusal::Io)?;
                UnixListener::bind(path)
                    .map_err(BindRefusal::Io)
                    .and_then(|l| secure_unix_listener(l, path))
            }
            Err(_) => Err(BindRefusal::StaleLocalEndpointUnverified {
                path: path.to_path_buf(),
            }),
        },
        Err(error) => Err(BindRefusal::Io(error)),
    }
}

#[cfg(unix)]
fn secure_unix_listener(
    listener: UnixListener,
    path: &Path,
) -> Result<ControlListener, BindRefusal> {
    if let Err(error) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        drop(listener);
        let _ = std::fs::remove_file(path);
        return Err(BindRefusal::Io(error));
    }
    Ok(ControlListener::Local(UnixSocketListener {
        listener,
        path: path.to_path_buf(),
    }))
}

#[cfg(unix)]
fn connect_local(path: &Path) -> io::Result<ControlStream> {
    UnixStream::connect(path).map(ControlStream::Local)
}

#[cfg(not(any(windows, unix)))]
fn bind_local(_: &Path) -> Result<ControlListener, BindRefusal> {
    Err(BindRefusal::UnsupportedLocalPlatform)
}
#[cfg(not(any(windows, unix)))]
fn connect_local(_: &Path) -> io::Result<ControlStream> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "local control transport requires Windows or Unix",
    ))
}

#[cfg(windows)]
fn platform_bind(addr: SocketAddr) -> Result<TcpListener, BindRefusal> {
    const ATTEMPTS: u32 = 50;
    const INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);
    let mut last = None;
    for _ in 0..ATTEMPTS {
        match TcpListener::bind(addr) {
            Ok(listener) => return Ok(listener),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                last = Some(e);
                std::thread::sleep(INTERVAL);
            }
            Err(e) => return Err(BindRefusal::Io(e)),
        }
    }
    Err(BindRefusal::Io(last.expect("at least one attempt ran")))
}
#[cfg(not(windows))]
fn platform_bind(addr: SocketAddr) -> Result<TcpListener, BindRefusal> {
    TcpListener::bind(addr).map_err(BindRefusal::Io)
}

/// Why a bind was refused.
#[derive(Debug)]
pub enum BindRefusal {
    NonLoopbackWithoutToken { addr: SocketAddr },
    TokenTooWeak { length: usize, minimum: usize },
    PortReserved { port: u16, reason: &'static str },
    InvalidLocalEndpoint { detail: String },
    LocalParentNotPrivate { path: PathBuf },
    LocalEndpointOccupied { path: PathBuf },
    StaleLocalEndpointNotSocket { path: PathBuf },
    StaleLocalEndpointUnverified { path: PathBuf },
    UnsupportedLocalPlatform,
    Io(std::io::Error),
}

impl std::fmt::Display for BindRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NonLoopbackWithoutToken { addr } => write!(
                f,
                "refusing to bind {addr}: a non-loopback control plane requires a token"
            ),
            Self::TokenTooWeak { length, minimum } => {
                write!(f, "token is {length} bytes, minimum is {minimum}")
            }
            Self::PortReserved { port, reason } => write!(f, "port {port} is reserved: {reason}"),
            Self::InvalidLocalEndpoint { detail } => {
                write!(f, "invalid local control endpoint: {detail}")
            }
            Self::LocalParentNotPrivate { path } => write!(
                f,
                "local socket parent is not owner-private: {}",
                path.display()
            ),
            Self::LocalEndpointOccupied { path } => {
                write!(f, "local control endpoint is occupied: {}", path.display())
            }
            Self::StaleLocalEndpointNotSocket { path } => write!(
                f,
                "stale local endpoint is not a socket: {}",
                path.display()
            ),
            Self::StaleLocalEndpointUnverified { path } => write!(
                f,
                "could not prove local endpoint stale before cleanup: {}",
                path.display()
            ),
            Self::UnsupportedLocalPlatform => {
                write!(f, "local control transport is unsupported on this platform")
            }
            Self::Io(error) => write!(f, "could not bind: {error}"),
        }
    }
}
impl std::error::Error for BindRefusal {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        if let Self::Io(error) = self {
            Some(error)
        } else {
            None
        }
    }
}

pub const MINIMUM_TOKEN_BYTES: usize = 32;
pub const ENGINE_CONTROL_PORT: u16 = 4400;
const RESERVED: &[(u16, &str)] = &[
    (4200, "belonged to the retired v2 daemon"),
    (4100, "project API"),
    (4300, "playout-control"),
];

/// Decide whether the engine may listen at an endpoint.
pub fn check_endpoint(endpoint: &Endpoint, token: Option<&str>) -> Result<(), BindRefusal> {
    match endpoint {
        Endpoint::Tcp(addr) => check_bind(*addr, token),
        Endpoint::Local(path) => check_local_bind(path, token),
    }
}

/// Decide whether the engine may listen at a local endpoint.
pub fn check_local_bind(path: &Path, token: Option<&str>) -> Result<(), BindRefusal> {
    check_token(token)?;
    #[cfg(windows)]
    {
        let path = path.to_string_lossy();
        if !path.starts_with(r"\\.\pipe\") || path.len() == r"\\.\pipe\".len() {
            return Err(BindRefusal::InvalidLocalEndpoint {
                detail: "Windows local endpoints must be non-empty \\.\\pipe\\ names".to_string(),
            });
        }
    }
    #[cfg(unix)]
    {
        if !path.is_absolute() {
            return Err(BindRefusal::InvalidLocalEndpoint {
                detail: "Unix local endpoints must be absolute paths".to_string(),
            });
        }
        let parent = path
            .parent()
            .ok_or_else(|| BindRefusal::InvalidLocalEndpoint {
                detail: "Unix local endpoint has no parent directory".to_string(),
            })?;
        let metadata = std::fs::metadata(parent).map_err(BindRefusal::Io)?;
        if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
            return Err(BindRefusal::LocalParentNotPrivate {
                path: parent.to_path_buf(),
            });
        }
    }
    Ok(())
}

/// Decide whether the engine may listen at a TCP address.
pub fn check_bind(addr: SocketAddr, token: Option<&str>) -> Result<(), BindRefusal> {
    if let Some((port, reason)) = RESERVED.iter().find(|(port, _)| *port == addr.port()) {
        return Err(BindRefusal::PortReserved {
            port: *port,
            reason,
        });
    }
    check_token(token)?;
    if token.is_some() || is_loopback(addr.ip()) {
        Ok(())
    } else {
        Err(BindRefusal::NonLoopbackWithoutToken { addr })
    }
}
fn check_token(token: Option<&str>) -> Result<(), BindRefusal> {
    if let Some(token) = token {
        if token.len() < MINIMUM_TOKEN_BYTES {
            return Err(BindRefusal::TokenTooWeak {
                length: token.len(),
                minimum: MINIMUM_TOKEN_BYTES,
            });
        }
    }
    Ok(())
}
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
        let endpoint = addr("192.168.1.50", ENGINE_CONTROL_PORT);
        assert!(
            matches!(check_bind(endpoint, None), Err(BindRefusal::NonLoopbackWithoutToken { addr }) if addr == endpoint)
        );
    }
    #[test]
    fn an_unspecified_address_is_not_loopback() {
        for ip in ["0.0.0.0", "::"] {
            assert!(check_bind(addr(ip, ENGINE_CONTROL_PORT), None).is_err());
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
        assert!(matches!(
            check_bind(addr("10.0.0.4", ENGINE_CONTROL_PORT), Some("secret")),
            Err(BindRefusal::TokenTooWeak {
                length: 6,
                minimum: MINIMUM_TOKEN_BYTES
            })
        ));
        assert!(check_bind(addr("127.0.0.1", ENGINE_CONTROL_PORT), Some("")).is_err());
    }
    #[test]
    fn burned_and_borrowed_ports_are_refused() {
        for (port, _) in RESERVED {
            assert!(matches!(
                check_bind(addr("127.0.0.1", *port), None),
                Err(BindRefusal::PortReserved { .. })
            ));
        }
    }
    #[test]
    fn the_engine_port_is_the_one_the_invariant_names() {
        assert_eq!(ENGINE_CONTROL_PORT, 4400);
    }
    #[cfg(windows)]
    #[test]
    fn a_local_pipe_requires_a_local_pipe_name() {
        assert!(matches!(
            check_local_bind(Path::new(r"\\remote-host\pipe\grapix"), None),
            Err(BindRefusal::InvalidLocalEndpoint { .. })
        ));
        assert!(check_local_bind(Path::new(r"\\.\pipe\grapix-test"), None).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn a_local_socket_requires_an_owner_private_parent() {
        assert!(matches!(
            check_local_bind(Path::new("grapix.sock"), None),
            Err(BindRefusal::InvalidLocalEndpoint { .. })
        ));
    }
}
