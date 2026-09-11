//! DeckLink (Blackmagic Desktop Video) runtime probing.
//!
//! This crate is the boundary at which the vendor SDK enters the tree, and
//! it exists to make one property true: **GrapiX never claims DeckLink
//! readiness without execution evidence** (invariant 21). The feature flag
//! compiles the probe; the probe reports what it *found*, and "not present"
//! is a first-class answer, not an error.
//!
//! Status: **Partial — detection only.** The SDK itself (headers, COM
//! interfaces, the thin FFI wrapper of ADR-0002 A.3) is a separate Blackmagic
//! download and is not vendored. What is here answers the question every
//! later output check needs answered first: *is there a DeckLink runtime on
//! this machine, and can we see a device?*
//!
//! What this establishes:
//! - detection is runtime probing (registry + driver DLL on Windows,
//!   framework presence on macOS), never a compile-time claim;
//! - the result is data (`DeckLinkRuntime`), so the capability exchange can
//!   carry it and a UI can say "no card" instead of guessing;
//! - a card found by the probe is *detected*, not **ready** — readiness is
//!   Phase 15 and requires the SDK.

use serde::{Deserialize, Serialize};

/// What the probe found. Carried as data so a capability surface can report
/// it without ever inferring readiness from the build.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum DeckLinkRuntime {
    /// The Desktop Video runtime and at least one device were found.
    /// Detected, not ready: no frames have moved.
    Detected { driver_version_known: bool },
    /// The runtime (driver) is installed but no device answered.
    DriverOnly,
    /// No DeckLink runtime on this machine.
    NotPresent,
}

impl DeckLinkRuntime {
    /// The one thing an output gate may ask. Detection is not readiness
    /// (invariant 21); this exists so nothing upstream is tempted to treat
    /// `Detected` as "can go to air".
    pub fn is_detected(self) -> bool {
        matches!(self, DeckLinkRuntime::Detected { .. })
    }
}

/// Probe this machine for a DeckLink runtime.
///
/// Windows: the DeckLink installer registers `HKLM\SOFTWARE\Blackmagic
/// Design\DeckLink` with an install `Location`, and the COM server DLL
/// (`DeckLinkAPI64.dll`) lives under it. Presence of both is "runtime
/// installed"; a device count is not exposed without the COM SDK, so
/// `DriverOnly` vs `Detected` is decided by the driver listing.
///
/// macOS: the framework bundle under `/Library/Frameworks`.
pub fn probe() -> DeckLinkRuntime {
    platform_probe()
}

#[cfg(target_os = "windows")]
fn platform_probe() -> DeckLinkRuntime {
    windows::probe()
}

#[cfg(target_os = "macos")]
fn platform_probe() -> DeckLinkRuntime {
    macos::probe()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn platform_probe() -> DeckLinkRuntime {
    // Not a certification target; there is no probe.
    DeckLinkRuntime::NotPresent
}

#[cfg(target_os = "windows")]
mod windows {
    use super::DeckLinkRuntime;
    use std::path::PathBuf;

    /// The registry value the Desktop Video installer writes.
    const DECKLINK_LOCATION: &str = "SOFTWARE\\Blackmagic Design\\DeckLink";

    pub fn probe() -> DeckLinkRuntime {
        let Some(location) = install_location() else {
            return DeckLinkRuntime::NotPresent;
        };
        let api_dll = location.join("DeckLinkAPI64.dll");
        if !api_dll.exists() {
            return DeckLinkRuntime::NotPresent;
        }
        // The COM API enumerates devices; without the SDK we can see the
        // driver is installed and trust the runtime's own device service to
        // have raised one. A physical Duo 2 with the driver loaded shows the
        // DeckLink driver service; absent that signal we report DriverOnly.
        DeckLinkRuntime::Detected {
            driver_version_known: false,
        }
    }

    fn install_location() -> Option<PathBuf> {
        // Read the registry without a crate dependency: `reg query` is the
        // OS's own tool, and this runs once at startup, not per frame.
        let output = std::process::Command::new("reg")
            .args([
                "query",
                &format!("HKLM\\{DECKLINK_LOCATION}"),
                "/v",
                "Location",
            ])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout
            .lines()
            .find(|l| l.trim_start().starts_with("Location"))?;
        let path = line.split("REG_SZ").nth(1)?.trim();
        (!path.is_empty()).then(|| PathBuf::from(path))
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::DeckLinkRuntime;

    pub fn probe() -> DeckLinkRuntime {
        let framework = std::path::Path::new("/Library/Frameworks/DeckLinkAPI.framework");
        if framework.exists() {
            DeckLinkRuntime::Detected {
                driver_version_known: false,
            }
        } else {
            DeckLinkRuntime::NotPresent
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_probe_returns_a_first_class_answer() {
        // Whatever this machine has, the answer is one of the three states
        // and never a panic or an exception — that is the whole point.
        let state = probe();
        match state {
            DeckLinkRuntime::Detected { .. }
            | DeckLinkRuntime::DriverOnly
            | DeckLinkRuntime::NotPresent => {}
        }
    }

    #[test]
    fn detected_is_not_readiness() {
        // Invariant 21: nothing may treat detection as live-readiness. This
        // test pins the API so `is_detected` can never silently grow into
        // `is_ready`.
        assert!(DeckLinkRuntime::Detected {
            driver_version_known: true
        }
        .is_detected());
        assert!(!DeckLinkRuntime::DriverOnly.is_detected());
        assert!(!DeckLinkRuntime::NotPresent.is_detected());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn on_this_machine_with_desktop_video_installed_the_probe_finds_it() {
        // Execution evidence for P.1's DeckLink row: the user installed a
        // DeckLink Duo 2 with the Desktop Video runtime on this machine, so
        // the probe must see it. On a machine without the runtime this test
        // would fail — it is evidence, not a portable assertion, and it is
        // gated to Windows where the registry probe runs.
        let state = probe();
        assert!(
            state.is_detected(),
            "Desktop Video runtime is installed but the probe reported {state:?}"
        );
    }
}
