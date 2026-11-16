//! Correlation ids (ADR-0004 §2, build-plan row 2.13).
//!
//! An id names one action. It is minted where the action starts (a front-end
//! call, an MCP `tools/call`), carried with the action across every process it
//! reaches, and written on every log record the action causes, so one search
//! for it follows the action from the window to the engine.
//!
//! **A scope, not a parameter.** While a [`Scope`] is entered, every record the
//! *thread* writes without a `corr` of its own carries the scope's id (the sink
//! reads [`current`]). No function that logs has to be given the id. It holds
//! because each place an action's work happens does it on one thread: a Tauri
//! command (all are synchronous), the control client's request, the transport's
//! per-connection handler, and the MCP gate. An id that has to cross a thread is
//! passed explicitly and entered again on the other side.
//!
//! **An id is untrusted input to a log.** The front end mints its own, so an id
//! that arrives from outside is checked ([`is_valid`]: 1 to 64 characters of
//! `A-Z a-z 0-9 _ : -`) and replaced by a freshly minted one if it is not
//! ([`adopt`]). A line break, a quotation mark, a space and a `gx1.` credential
//! (which always contains dots) cannot reach a log through an id. The check is of
//! shape, not meaning: a credential that happened to be 64 plain characters would
//! pass it, which is why credentials are also kept out at their source
//! (`Redacted`, invariant 54) and why no caller puts one where an id goes.

use std::cell::RefCell;
use std::marker::PhantomData;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// The longest id accepted.
pub const MAX_LEN: usize = 64;

/// Whether `id` is an acceptable correlation id. No dot: every `gx1` credential
/// has two, and the control plane puts an id after the dots of its own request
/// ids (`req.<n>.<id>`), so an id with one could not be read back.
pub fn is_valid(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'-'))
}

/// A new id, unique across this machine's processes and runs: the prefix says
/// what minted it (`mcp`, `shell`), then this process's seed, then a count.
pub fn mint(prefix: &str) -> String {
    static SEED: OnceLock<String> = OnceLock::new();
    static COUNT: AtomicU64 = AtomicU64::new(0);
    let seed = SEED.get_or_init(|| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos());
        format!("{:x}{:x}", std::process::id(), (nanos & 0xffff_ffff) as u32)
    });
    let count = COUNT.fetch_add(1, Ordering::Relaxed) + 1;
    let id = format!("{prefix}-{seed}-{count}");
    // A prefix of ours is short and plain; one that is not still yields a valid id.
    if is_valid(&id) {
        id
    } else {
        format!("x-{seed}-{count}")
    }
}

/// What came of offering an id that arrived from outside.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Adopted {
    /// The presented id was acceptable and is used as it is.
    Kept(String),
    /// None was presented; this one was minted.
    Minted(String),
    /// One was presented and was not acceptable (wrong characters or too long);
    /// this one was minted instead. The presented text is not kept: it is what
    /// an id must never be able to carry into a log.
    Replaced(String),
}

impl Adopted {
    /// The id to use.
    pub fn id(&self) -> &str {
        match self {
            Self::Kept(id) | Self::Minted(id) | Self::Replaced(id) => id,
        }
    }

    /// Whether a presented id was refused.
    pub fn was_replaced(&self) -> bool {
        matches!(self, Self::Replaced(_))
    }
}

/// Take an id from outside if it is acceptable, else mint one with `prefix`.
pub fn adopt(presented: Option<&str>, prefix: &str) -> Adopted {
    match presented {
        Some(id) if is_valid(id) => Adopted::Kept(id.to_owned()),
        Some(_) => Adopted::Replaced(mint(prefix)),
        None => Adopted::Minted(mint(prefix)),
    }
}

thread_local! {
    static STACK: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

/// The id of the action this thread is working for, if one is entered.
pub fn current() -> Option<String> {
    STACK.with(|stack| stack.borrow().last().cloned())
}

/// A correlation scope: the thread works for one action until this drops.
///
/// Scopes nest (an inner one wins, and dropping it restores the outer) and are
/// tied to the thread that entered them, so a scope cannot be moved to a thread
/// whose work it does not describe.
#[must_use = "the scope ends when this is dropped"]
pub struct Scope {
    depth: usize,
    _thread: PhantomData<*const ()>,
}

/// Enter a scope for `id`. An id that is not valid is never entered: a fresh
/// one stands in for it, so nothing but a valid id is ever written.
pub fn enter(id: &str) -> Scope {
    let id = if is_valid(id) {
        id.to_owned()
    } else {
        mint("bad")
    };
    STACK.with(|stack| {
        let mut stack = stack.borrow_mut();
        stack.push(id);
        Scope {
            depth: stack.len(),
            _thread: PhantomData,
        }
    })
}

impl Drop for Scope {
    fn drop(&mut self) {
        // Back to the depth this scope was entered at, whatever order scopes
        // are dropped in.
        STACK.with(|stack| stack.borrow_mut().truncate(self.depth - 1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_short_plain_id_is_valid() {
        for good in ["a", "ed-1a2b-7", "mcp-9_x:y", &"a".repeat(MAX_LEN)] {
            assert!(is_valid(good), "{good}");
        }
        for bad in [
            "",
            &"a".repeat(MAX_LEN + 1),
            "has space",
            "new\nline",
            "quote\"mark",
            "gx1.payload.mac",
            "dotted.id",
            "slash/path",
            "naïve",
            "tab\t",
        ] {
            assert!(!is_valid(bad), "{bad:?}");
        }
    }

    #[test]
    fn minted_ids_are_valid_and_never_repeat() {
        let first = mint("shell");
        let second = mint("shell");
        assert!(is_valid(&first) && is_valid(&second));
        assert_ne!(first, second);
        assert!(first.starts_with("shell-"));
        // A prefix that is not plain still gives a valid id.
        assert!(is_valid(&mint("not plain!")));
    }

    #[test]
    fn an_outside_id_is_kept_if_valid_and_replaced_if_not_without_keeping_its_text() {
        assert_eq!(adopt(Some("ed-1"), "shell"), Adopted::Kept("ed-1".into()));
        assert!(matches!(adopt(None, "shell"), Adopted::Minted(id) if id.starts_with("shell-")));
        let token = "gx1.eyJzdWIiOiJvcCJ9.deadbeef";
        let replaced = adopt(Some(token), "shell");
        assert!(replaced.was_replaced());
        assert!(!replaced.id().contains("gx1") && is_valid(replaced.id()));
    }

    #[test]
    fn scopes_nest_restore_and_are_per_thread() {
        assert_eq!(current(), None);
        let outer = enter("outer-1");
        assert_eq!(current().as_deref(), Some("outer-1"));
        {
            let _inner = enter("inner-2");
            assert_eq!(current().as_deref(), Some("inner-2"));
            // Another thread has no scope of its own.
            std::thread::spawn(|| assert_eq!(current(), None))
                .join()
                .unwrap();
        }
        assert_eq!(current().as_deref(), Some("outer-1"));
        drop(outer);
        assert_eq!(current(), None);
    }

    #[test]
    fn a_scope_dropped_out_of_order_still_restores_what_was_there_before() {
        let outer = enter("a-1");
        let inner = enter("b-2");
        drop(outer);
        // The outer scope is gone, and so is everything entered after it.
        assert_eq!(current(), None);
        drop(inner);
        assert_eq!(current(), None);
    }

    #[test]
    fn an_invalid_id_is_never_entered() {
        let _scope = enter("bad id\nwith a newline");
        let now = current().expect("a scope is entered");
        assert!(is_valid(&now) && !now.contains('\n'));
    }
}
