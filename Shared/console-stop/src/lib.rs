//! Tell a console process why it is being stopped, while it can still write
//! that down (build plan 2.16, 2.18).
//!
//! A Windows console process that is ended from its console (Ctrl+C,
//! Ctrl+Break, the window's close button, a logoff, a shutdown) runs none of
//! its own code unless it has registered a console control handler. This crate
//! is that registration and nothing else: [`on_console_event`] takes a closure
//! and calls it, with the event that came, **on the thread the system made for
//! the handler and before the handler returns**. That ordering is the point of
//! the crate. For a window close Windows ends the process the moment the
//! handler returns, so work done on another thread (which is how the `ctrlc`
//! crate runs a handler) loses the race: the engine's log ended at
//! `engine.stop` with no `log.stop` (2.16, limit 1).
//!
//! This is the one crate in the stop path that contains `unsafe`: a single
//! call to `SetConsoleCtrlHandler` (user decision, 17 Nov 2026). It is here so
//! that every crate using it can keep `#![forbid(unsafe_code)]`.
//!
//! Limits, named rather than hidden:
//!
//! - The closure has a few seconds, not for ever. After a window close Windows
//!   ends the process about five seconds after the event if the handler has
//!   not returned.
//! - A process that has loaded `user32.dll` or `gdi32.dll` is not sent the
//!   logoff and shutdown events at all (Windows documents this). They are
//!   handled here if they arrive; neither has been run.
//! - A process with no console gets no event.
//! - Off Windows the closure is handed to `ctrlc` and sees only
//!   [`ConsoleEvent::Interrupt`]. That path is not compiled on this machine
//!   and has not been run (Windows-supported work comes first).

#![deny(unsafe_code)]

use std::fmt;
use std::sync::OnceLock;

/// What ended the process from its console.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsoleEvent {
    /// Ctrl+C was pressed in the console.
    CtrlC,
    /// Ctrl+Break was pressed in the console.
    CtrlBreak,
    /// The console window was closed (its close button, or a request to close).
    Close,
    /// The user is logging off.
    Logoff,
    /// The system is shutting down.
    Shutdown,
    /// An interrupt signal, off Windows.
    Interrupt,
}

impl ConsoleEvent {
    /// The event in words, for a stop record's reason.
    pub const fn reason(self) -> &'static str {
        match self {
            Self::CtrlC => "Ctrl+C at the console",
            Self::CtrlBreak => "Ctrl+Break at the console",
            Self::Close => "the console window was closed",
            Self::Logoff => "the user logged off",
            Self::Shutdown => "the system is shutting down",
            Self::Interrupt => "an interrupt signal",
        }
    }

    /// The event for a Windows console control code, or `None` for a code this
    /// crate does not know (which is then left to the next handler).
    pub const fn from_control_code(code: u32) -> Option<Self> {
        // The values of CTRL_C_EVENT, CTRL_BREAK_EVENT, CTRL_CLOSE_EVENT,
        // CTRL_LOGOFF_EVENT and CTRL_SHUTDOWN_EVENT. 3 and 4 are reserved.
        match code {
            0 => Some(Self::CtrlC),
            1 => Some(Self::CtrlBreak),
            2 => Some(Self::Close),
            5 => Some(Self::Logoff),
            6 => Some(Self::Shutdown),
            _ => None,
        }
    }
}

/// Why the handler could not be installed.
#[derive(Debug)]
pub enum InstallError {
    /// A handler was already installed in this process. There is one.
    AlreadyInstalled,
    /// The system refused the registration.
    System(std::io::Error),
}

impl fmt::Display for InstallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadyInstalled => f.write_str("a console handler is already installed"),
            Self::System(error) => write!(f, "the system refused the console handler: {error}"),
        }
    }
}

impl std::error::Error for InstallError {}

type Handler = Box<dyn Fn(ConsoleEvent) + Send + Sync>;

static HANDLER: OnceLock<Handler> = OnceLock::new();

/// Call `handler` when the console ends this process, with the event that
/// came, on the system's handler thread and before the process is ended.
///
/// The closure normally records the stop and exits the process. If it returns,
/// the event counts as handled: Ctrl+C and Ctrl+Break then leave the process
/// running, and a close, logoff or shutdown ends it.
///
/// One handler per process: a second call is refused.
pub fn on_console_event(
    handler: impl Fn(ConsoleEvent) + Send + Sync + 'static,
) -> Result<(), InstallError> {
    if HANDLER.set(Box::new(handler)).is_err() {
        return Err(InstallError::AlreadyInstalled);
    }
    platform::register()
}

/// Hand a control code to the installed closure, as the system does. Returns
/// whether the event was handled: `false` for a code this crate does not know,
/// when no closure is installed, or when the closure panicked (the event then
/// goes to the next handler, which by default ends the process).
///
/// Public so a test can deliver an event without raising one on a console it
/// shares with the test runner.
pub fn deliver(code: u32) -> bool {
    let (Some(event), Some(handler)) = (ConsoleEvent::from_control_code(code), HANDLER.get())
    else {
        return false;
    };
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(event))).is_ok()
}

#[cfg(windows)]
mod platform {
    use super::InstallError;
    use windows_sys::core::BOOL;
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;

    /// What the system calls, on a thread it creates for the purpose.
    extern "system" fn routine(code: u32) -> BOOL {
        BOOL::from(super::deliver(code))
    }

    pub(super) fn register() -> Result<(), InstallError> {
        // SAFETY: `routine` is a plain function with the signature the system
        // expects, it lives for the life of the process, and it does not
        // unwind (`deliver` catches a panic). Adding a handler has no other
        // precondition.
        #[allow(unsafe_code)]
        let added = unsafe { SetConsoleCtrlHandler(Some(routine), 1) };
        if added == 0 {
            return Err(InstallError::System(std::io::Error::last_os_error()));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{ConsoleEvent, InstallError, HANDLER};

    pub(super) fn register() -> Result<(), InstallError> {
        ctrlc::set_handler(|| {
            if let Some(handler) = HANDLER.get() {
                handler(ConsoleEvent::Interrupt);
            }
        })
        .map_err(|error| InstallError::System(std::io::Error::other(error)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_control_code_is_its_own_event_and_the_reserved_ones_are_none() {
        let known: Vec<(u32, ConsoleEvent)> = (0..=8)
            .filter_map(|code| ConsoleEvent::from_control_code(code).map(|event| (code, event)))
            .collect();
        assert_eq!(
            known,
            [
                (0, ConsoleEvent::CtrlC),
                (1, ConsoleEvent::CtrlBreak),
                (2, ConsoleEvent::Close),
                (5, ConsoleEvent::Logoff),
                (6, ConsoleEvent::Shutdown),
            ]
        );
    }

    #[test]
    fn every_event_has_its_own_reason() {
        let events = [
            ConsoleEvent::CtrlC,
            ConsoleEvent::CtrlBreak,
            ConsoleEvent::Close,
            ConsoleEvent::Logoff,
            ConsoleEvent::Shutdown,
            ConsoleEvent::Interrupt,
        ];
        let reasons: std::collections::BTreeSet<&str> =
            events.iter().map(|event| event.reason()).collect();
        assert_eq!(reasons.len(), events.len());
        assert_eq!(
            ConsoleEvent::Close.reason(),
            "the console window was closed"
        );
    }
}
