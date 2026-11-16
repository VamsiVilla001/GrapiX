//! An exclusive advisory lock on a file, held for as long as the value lives
//! (build plan 8.12).
//!
//! A read-check-write on a stored scene is only a compare-and-swap if no other
//! writer can slip between the read and the write. The writers are the Editor
//! shell and every MCP server process, so the lock has to hold across
//! processes, not just threads. The operating system releases it when the
//! handle closes, including when the process dies, so a crashed writer never
//! leaves the store locked.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

/// The held lock. Dropping it releases it.
#[derive(Debug)]
pub struct FileLock {
    file: File,
}

impl FileLock {
    /// Wait for the exclusive lock on `path`, creating the file if absent.
    ///
    /// The file's contents are never read or written: it exists to be locked.
    /// The wait is unbounded by design: a write holds the lock for one scene
    /// read and one atomic replace, and giving up would turn contention into
    /// a lost write the caller has to notice.
    pub fn exclusive(path: &Path) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        file.lock()?;
        Ok(Self { file })
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        // Closing the handle releases the lock too; unlocking first just makes
        // the release immediate and explicit. A failure leaves nothing to do.
        let _ = self.file.unlock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("gx-fs-lock-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("write.lock")
    }

    #[test]
    fn a_second_holder_waits_for_the_first() {
        // Two threads each take the lock and bump a counter with a pause in
        // the middle. If the lock did not exclude, the second would observe
        // the counter mid-update.
        let path = Arc::new(scratch("excludes"));
        let inside = Arc::new(AtomicU32::new(0));
        let overlapped = Arc::new(AtomicU32::new(0));
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let (path, inside, overlapped) = (path.clone(), inside.clone(), overlapped.clone());
                std::thread::spawn(move || {
                    for _ in 0..5 {
                        let _held = FileLock::exclusive(&path).expect("the lock is taken");
                        if inside.fetch_add(1, Ordering::SeqCst) != 0 {
                            overlapped.fetch_add(1, Ordering::SeqCst);
                        }
                        std::thread::sleep(std::time::Duration::from_millis(2));
                        inside.fetch_sub(1, Ordering::SeqCst);
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(
            overlapped.load(Ordering::SeqCst),
            0,
            "two holders overlapped"
        );
    }

    #[test]
    fn the_lock_is_released_when_the_holder_drops() {
        let path = scratch("released");
        drop(FileLock::exclusive(&path).unwrap());
        // A second acquisition would hang the test if the first were still held.
        drop(FileLock::exclusive(&path).unwrap());
    }
}
