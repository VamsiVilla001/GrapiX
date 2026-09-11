//! Normalised, debounced file watching (build plan 2.5).
//!
//! Atomic replacement deliberately creates and modifies a `.gxtmp` file before
//! renaming it over its target. Native filesystem APIs disagree about how that
//! sequence is reported, so exposing their notifications would make an editor
//! react differently on macOS and Windows. This module turns those sequences
//! into one small, stable event vocabulary and suppresses the implementation
//! temporary. It uses `notify` 8, whose MIT/Apache-2.0 licence is permitted by
//! the dependency policy, because it selects the platform-native FSEvents and
//! Win32 backends without making either backend part of this crate's API.
//!
//! A watcher owns both the native handle and its debouncing worker. Dropping it
//! stops the worker synchronously, preventing callbacks from outliving a caller
//! that has closed a project.

use std::error::Error;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::event::{ModifyKind, RenameMode};
use notify::{Event as NotifyEvent, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

/// The stable events callers receive after platform normalisation and debounce.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WatchEvent {
    /// A path appeared during the debounce window.
    Created(PathBuf),
    /// A path's durable contents changed during the debounce window.
    Modified(PathBuf),
    /// A path disappeared during the debounce window.
    Removed(PathBuf),
    /// A non-temporary path moved to another non-temporary path.
    Renamed { from: PathBuf, to: PathBuf },
}

/// Why a watcher could not start, interpret a platform event, or receive one.
#[derive(Debug)]
pub enum WatchError {
    /// The operating-system watcher could not be constructed.
    Create(notify::Error),
    /// The requested path could not be registered with the watcher.
    Register {
        path: PathBuf,
        source: notify::Error,
    },
    /// The worker that applies debounce could not be started.
    WorkerSpawn(io::Error),
    /// The native backend itself reported a failure.
    Backend(notify::Error),
    /// The backend reported an event which has no lossless representation here.
    UnsupportedBackendEvent { kind: String },
    /// A rename notification did not contain exactly the paths it requires.
    MalformedRename { paths: Vec<PathBuf> },
    /// A backend supplied the destination of a rename without its source.
    UnpairedRenameTo { path: PathBuf },
    /// A backend supplied the source of a rename without its destination.
    UnpairedRenameFrom { path: PathBuf },
    /// No normalised event arrived before the requested wait elapsed.
    Timeout,
    /// The owning watcher has been dropped and no further events can arrive.
    Stopped,
}

impl fmt::Display for WatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Create(source) => write!(formatter, "could not create file watcher: {source}"),
            Self::Register { path, source } => {
                write!(formatter, "could not watch {}: {source}", path.display())
            }
            Self::WorkerSpawn(source) => {
                write!(formatter, "could not start watcher worker: {source}")
            }
            Self::Backend(source) => write!(formatter, "file watcher backend failed: {source}"),
            Self::UnsupportedBackendEvent { kind } => {
                write!(
                    formatter,
                    "file watcher cannot normalise backend event {kind}"
                )
            }
            Self::MalformedRename { paths } => {
                write!(
                    formatter,
                    "file watcher received malformed rename with paths {paths:?}"
                )
            }
            Self::UnpairedRenameTo { path } => {
                write!(
                    formatter,
                    "file watcher received rename destination without source: {}",
                    path.display()
                )
            }
            Self::UnpairedRenameFrom { path } => {
                write!(
                    formatter,
                    "file watcher received rename source without destination: {}",
                    path.display()
                )
            }
            Self::Timeout => formatter.write_str("timed out waiting for file watcher event"),
            Self::Stopped => formatter.write_str("file watcher has stopped"),
        }
    }
}

impl Error for WatchError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Create(source) | Self::Backend(source) => Some(source),
            Self::Register { source, .. } => Some(source),
            Self::WorkerSpawn(source) => Some(source),
            Self::UnsupportedBackendEvent { .. }
            | Self::MalformedRename { .. }
            | Self::UnpairedRenameTo { .. }
            | Self::UnpairedRenameFrom { .. }
            | Self::Timeout
            | Self::Stopped => None,
        }
    }
}

/// A native directory registration and the worker that normalises its events.
pub struct FileWatcher {
    watcher: Option<RecommendedWatcher>,
    raw_sender: Sender<RawMessage>,
    active: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

/// The receiving half of a [`FileWatcher`].
///
/// It stays observable after the watcher is dropped so a caller can learn that
/// no more events will arrive rather than treating a closed project as a quiet
/// timeout.
pub struct WatchStream {
    receiver: Receiver<Result<WatchEvent, WatchError>>,
}

/// Start watching one directory without recursing into its descendants.
///
/// The returned stream produces at most one coalesced event per path within
/// each `debounce` window. A zero window is valid when a caller needs the raw
/// pacing while retaining the cross-platform normalisation.
pub fn watch_directory(
    path: impl AsRef<Path>,
    debounce: Duration,
) -> Result<(FileWatcher, WatchStream), WatchError> {
    let path = path.as_ref().to_path_buf();
    let (raw_sender, raw_receiver) = mpsc::channel();
    let callback_sender = raw_sender.clone();
    let active = Arc::new(AtomicBool::new(true));
    let callback_active = Arc::clone(&active);
    let mut watcher = notify::recommended_watcher(move |event| {
        if !callback_active.load(Ordering::Acquire) {
            return;
        }

        let message = match event {
            Ok(event) => backend_events_from_notify(event),
            Err(error) => Err(WatchError::Backend(error)),
        };
        let _ = callback_sender.send(RawMessage::Events(message));
    })
    .map_err(WatchError::Create)?;

    watcher
        .watch(&path, RecursiveMode::NonRecursive)
        .map_err(|source| WatchError::Register {
            path: path.clone(),
            source,
        })?;

    let (event_sender, event_receiver) = mpsc::channel();
    let worker = spawn_worker(raw_receiver, event_sender, Arc::clone(&active), debounce)?;

    Ok((
        FileWatcher {
            watcher: Some(watcher),
            raw_sender,
            active,
            worker: Some(worker),
        },
        WatchStream {
            receiver: event_receiver,
        },
    ))
}

impl Drop for FileWatcher {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        drop(self.watcher.take());
        let _ = self.raw_sender.send(RawMessage::Stop);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl WatchStream {
    /// Wait for the next normalised, debounced event.
    pub fn recv(&self) -> Result<WatchEvent, WatchError> {
        self.receiver.recv().map_err(|_| WatchError::Stopped)?
    }

    /// Wait no longer than `timeout` for the next normalised event.
    pub fn recv_timeout(&self, timeout: Duration) -> Result<WatchEvent, WatchError> {
        match self.receiver.recv_timeout(timeout) {
            Ok(event) => event,
            Err(RecvTimeoutError::Timeout) => Err(WatchError::Timeout),
            Err(RecvTimeoutError::Disconnected) => Err(WatchError::Stopped),
        }
    }
}

#[derive(Debug)]
enum RawMessage {
    Events(Result<Vec<RawEvent>, WatchError>),
    Stop,
}

/// The event-level facts supplied by FSEvents and ReadDirectoryChangesW.
///
/// This type intentionally stays private: callers receive [`WatchEvent`], and
/// tests replay native sequences through [`normalise`] without needing either
/// platform's backend to run.
#[derive(Clone, Debug, Eq, PartialEq)]
enum RawEvent {
    Created(PathBuf),
    Modified(PathBuf),
    Removed(PathBuf),
    RenameFrom(PathBuf),
    RenameTo(PathBuf),
    Renamed { from: PathBuf, to: PathBuf },
}

fn spawn_worker(
    raw_receiver: Receiver<RawMessage>,
    event_sender: Sender<Result<WatchEvent, WatchError>>,
    active: Arc<AtomicBool>,
    debounce: Duration,
) -> Result<JoinHandle<()>, WatchError> {
    thread::Builder::new()
        .name("gx-fs-watch".to_owned())
        .spawn(move || worker_loop(raw_receiver, event_sender, active, debounce))
        .map_err(WatchError::WorkerSpawn)
}

fn worker_loop(
    raw_receiver: Receiver<RawMessage>,
    event_sender: Sender<Result<WatchEvent, WatchError>>,
    active: Arc<AtomicBool>,
    debounce: Duration,
) {
    while active.load(Ordering::Acquire) {
        let first = match raw_receiver.recv() {
            Ok(RawMessage::Events(events)) => events,
            Ok(RawMessage::Stop) | Err(_) => return,
        };
        if !active.load(Ordering::Acquire) {
            return;
        }

        let mut raw_events = Vec::new();
        let mut errors = Vec::new();
        collect_message(first, &mut raw_events, &mut errors);
        let deadline = Instant::now() + debounce;

        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match raw_receiver.recv_timeout(remaining) {
                Ok(RawMessage::Events(events)) => {
                    collect_message(events, &mut raw_events, &mut errors)
                }
                Ok(RawMessage::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                Err(RecvTimeoutError::Timeout) => break,
            }
            if !active.load(Ordering::Acquire) {
                return;
            }
        }

        if !active.load(Ordering::Acquire) {
            return;
        }
        match normalise(&raw_events) {
            Ok(events) => {
                for event in events {
                    if !active.load(Ordering::Acquire) {
                        return;
                    }
                    if event_sender.send(Ok(event)).is_err() {
                        return;
                    }
                }
            }
            Err(error) => {
                if event_sender.send(Err(error)).is_err() {
                    return;
                }
            }
        }
        for error in errors {
            if !active.load(Ordering::Acquire) || event_sender.send(Err(error)).is_err() {
                return;
            }
        }
    }
}

fn collect_message(
    message: Result<Vec<RawEvent>, WatchError>,
    raw_events: &mut Vec<RawEvent>,
    errors: &mut Vec<WatchError>,
) {
    match message {
        Ok(events) => raw_events.extend(events),
        Err(error) => errors.push(error),
    }
}

fn backend_events_from_notify(event: NotifyEvent) -> Result<Vec<RawEvent>, WatchError> {
    match event.kind {
        EventKind::Create(_) => Ok(event.paths.into_iter().map(RawEvent::Created).collect()),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => rename_pair(event.paths),
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
            Ok(event.paths.into_iter().map(RawEvent::RenameFrom).collect())
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
            Ok(event.paths.into_iter().map(RawEvent::RenameTo).collect())
        }
        EventKind::Modify(ModifyKind::Name(mode)) => Err(WatchError::UnsupportedBackendEvent {
            kind: format!("rename {mode:?}"),
        }),
        EventKind::Modify(_) => Ok(event.paths.into_iter().map(RawEvent::Modified).collect()),
        EventKind::Remove(_) => Ok(event.paths.into_iter().map(RawEvent::Removed).collect()),
        kind => Err(WatchError::UnsupportedBackendEvent {
            kind: format!("{kind:?}"),
        }),
    }
}

fn rename_pair(paths: Vec<PathBuf>) -> Result<Vec<RawEvent>, WatchError> {
    let [from, to]: [PathBuf; 2] = paths
        .try_into()
        .map_err(|paths: Vec<PathBuf>| WatchError::MalformedRename { paths })?;
    Ok(vec![RawEvent::Renamed { from, to }])
}

/// Turn one debounce window of backend facts into stable filesystem events.
///
/// This is deliberately pure so recorded FSEvents and Win32 sequences can be
/// held to the same contract. Rename halves must be adjacent within a window;
/// an unpaired half is reported by name rather than guessed from a path.
fn normalise(raw_events: &[RawEvent]) -> Result<Vec<WatchEvent>, WatchError> {
    let mut events = Vec::new();
    let mut rename_from = None;

    for raw_event in raw_events {
        match raw_event {
            RawEvent::Created(path) => {
                push_path_event(&mut events, WatchEvent::Created(path.clone()))
            }
            RawEvent::Modified(path) => {
                push_path_event(&mut events, WatchEvent::Modified(path.clone()))
            }
            RawEvent::Removed(path) => {
                push_path_event(&mut events, WatchEvent::Removed(path.clone()))
            }
            RawEvent::RenameFrom(path) => {
                if let Some(previous) = rename_from.replace(path.clone()) {
                    return Err(WatchError::UnpairedRenameFrom { path: previous });
                }
            }
            RawEvent::RenameTo(to) => {
                let from = rename_from
                    .take()
                    .ok_or_else(|| WatchError::UnpairedRenameTo { path: to.clone() })?;
                push_rename_event(&mut events, from, to.clone());
            }
            RawEvent::Renamed { from, to } => {
                push_rename_event(&mut events, from.clone(), to.clone())
            }
        }
    }

    if let Some(path) = rename_from {
        return Err(WatchError::UnpairedRenameFrom { path });
    }
    Ok(events)
}

fn push_rename_event(events: &mut Vec<WatchEvent>, from: PathBuf, to: PathBuf) {
    match (is_atomic_temporary(&from), is_atomic_temporary(&to)) {
        (true, true) => {}
        (true, false) => push_path_event(events, WatchEvent::Modified(to)),
        (false, true) => push_path_event(events, WatchEvent::Removed(from)),
        (false, false) => {
            if !events.iter().any(|event| {
                matches!(event, WatchEvent::Renamed { from: existing_from, to: existing_to } if existing_from == &from && existing_to == &to)
            }) {
                events.push(WatchEvent::Renamed { from, to });
            }
        }
    }
}

fn push_path_event(events: &mut Vec<WatchEvent>, event: WatchEvent) {
    let path = path_of(&event).expect("path events always carry one path");
    if is_atomic_temporary(path) {
        return;
    }

    if let Some(index) = events
        .iter()
        .position(|existing| path_of(existing) == Some(path))
    {
        let existing = events.remove(index);
        if let Some(coalesced) = coalesce(existing, event) {
            events.insert(index, coalesced);
        }
    } else {
        events.push(event);
    }
}

fn path_of(event: &WatchEvent) -> Option<&Path> {
    match event {
        WatchEvent::Created(path) | WatchEvent::Modified(path) | WatchEvent::Removed(path) => {
            Some(path)
        }
        WatchEvent::Renamed { .. } => None,
    }
}

fn coalesce(previous: WatchEvent, next: WatchEvent) -> Option<WatchEvent> {
    match (previous, next) {
        (WatchEvent::Created(path), WatchEvent::Modified(_)) => Some(WatchEvent::Created(path)),
        (WatchEvent::Created(_), WatchEvent::Removed(_)) => None,
        (WatchEvent::Modified(_), WatchEvent::Created(path))
        | (WatchEvent::Modified(_), WatchEvent::Modified(path)) => Some(WatchEvent::Modified(path)),
        (WatchEvent::Modified(_), WatchEvent::Removed(path)) => Some(WatchEvent::Removed(path)),
        (WatchEvent::Removed(_), WatchEvent::Created(path))
        | (WatchEvent::Removed(_), WatchEvent::Modified(path)) => Some(WatchEvent::Modified(path)),
        (WatchEvent::Removed(path), WatchEvent::Removed(_)) => Some(WatchEvent::Removed(path)),
        (previous, next) => unreachable!("only path events reach coalesce: {previous:?}, {next:?}"),
    }
}

fn is_atomic_temporary(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension == "gxtmp")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::write_atomic;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn test_directory(name: &str) -> PathBuf {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "gx-fs-watch-{name}-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&directory).unwrap();
        directory
    }

    #[test]
    fn normalises_equivalent_win32_and_fsevents_atomic_save_sequences() {
        let target = PathBuf::from("project.gpx");
        let temporary = PathBuf::from(".project.gpx.42.0.1.gxtmp");
        let win32 = vec![
            RawEvent::Created(temporary.clone()),
            RawEvent::Modified(temporary.clone()),
            RawEvent::Renamed {
                from: temporary.clone(),
                to: target.clone(),
            },
        ];
        let fsevents = vec![
            RawEvent::Created(temporary.clone()),
            RawEvent::Modified(temporary.clone()),
            RawEvent::Removed(target.clone()),
            RawEvent::RenameFrom(temporary),
            RawEvent::RenameTo(target.clone()),
        ];
        let expected = vec![WatchEvent::Modified(target)];

        assert_eq!(normalise(&win32).unwrap(), expected);
        assert_eq!(normalise(&fsevents).unwrap(), expected);
    }

    #[test]
    fn coalesces_repeated_modifications_for_one_path() {
        let path = PathBuf::from("project.gpx");
        let events = normalise(&[
            RawEvent::Modified(path.clone()),
            RawEvent::Modified(path.clone()),
            RawEvent::Modified(path.clone()),
        ])
        .unwrap();

        assert_eq!(events, vec![WatchEvent::Modified(path)]);
    }

    #[cfg(windows)]
    #[test]
    fn atomic_save_emits_one_target_modification_and_no_temporary_event() {
        let directory = test_directory("atomic-save");
        let target = directory.join("project.gpx");
        fs::write(&target, b"old").unwrap();
        let (watcher, stream) = watch_directory(&directory, Duration::from_millis(100)).unwrap();

        write_atomic(&target, b"new").unwrap();

        let first = stream.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(first, WatchEvent::Modified(target));
        assert!(matches!(
            stream.recv_timeout(Duration::from_millis(300)),
            Err(WatchError::Timeout)
        ));

        drop(watcher);
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn dropping_watcher_stops_delivery_and_releases_its_directory_handle() {
        let directory = test_directory("drop");
        let (watcher, stream) = watch_directory(&directory, Duration::from_millis(20)).unwrap();

        drop(watcher);
        assert!(matches!(
            stream.recv_timeout(Duration::from_millis(100)),
            Err(WatchError::Stopped)
        ));
        fs::remove_dir_all(directory).unwrap();
    }
}
