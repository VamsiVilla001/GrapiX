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

/// The most edit ids one publish names (2.17). A person can make hundreds of
/// edits between two publishes; the newest are named and the rest are counted.
pub const MAX_CARRIED: usize = 64;

/// What a publish carries: the ids of the edits it holds, and how many more it
/// holds that are not named.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Carried {
    ids: Vec<String>,
    dropped: u64,
}

thread_local! {
    static CARRIED: RefCell<Vec<Carried>> = const { RefCell::new(Vec::new()) };
}

/// A carry scope: while it is entered, this thread's publish names the edit ids
/// it was given (2.17). Like [`Scope`], tied to the thread that entered it.
#[must_use = "the scope ends when this is dropped"]
pub struct CarryScope {
    depth: usize,
    _thread: PhantomData<*const ()>,
}

/// Enter a carry scope for `ids`, the ids of the edits a publish holds.
///
/// Only ids that pass [`is_valid`] are kept, once each, and at most
/// [`MAX_CARRIED`] of them: the newest, which are the last given. Every id left
/// out (invalid, repeated, or beyond the limit) adds to the count, together with
/// `already_dropped` (the ids the caller itself could not keep), so a record can
/// say how many edits it holds that it does not name.
pub fn carry(ids: &[String], already_dropped: u64) -> CarryScope {
    let mut kept: Vec<String> = Vec::new();
    let mut dropped = already_dropped;
    for id in ids {
        if !is_valid(id) || kept.contains(id) {
            dropped += 1;
        } else {
            kept.push(id.clone());
        }
    }
    if kept.len() > MAX_CARRIED {
        let over = kept.len() - MAX_CARRIED;
        kept.drain(..over);
        dropped += over as u64;
    }
    CARRIED.with(|stack| {
        let mut stack = stack.borrow_mut();
        stack.push(Carried { ids: kept, dropped });
        CarryScope {
            depth: stack.len(),
            _thread: PhantomData,
        }
    })
}

impl Drop for CarryScope {
    fn drop(&mut self) {
        CARRIED.with(|stack| stack.borrow_mut().truncate(self.depth - 1));
    }
}

/// The edit ids the publish this thread is working for names, oldest first.
pub fn carried() -> Vec<String> {
    CARRIED.with(|stack| {
        stack
            .borrow()
            .last()
            .map(|c| c.ids.clone())
            .unwrap_or_default()
    })
}

/// How many edits that publish holds without naming them.
pub fn carried_dropped() -> u64 {
    CARRIED.with(|stack| stack.borrow().last().map_or(0, |c| c.dropped))
}

/// The named edit ids as one log field, comma-separated (an id never contains a
/// comma), or `None` when there are none, so a record without edits carries no
/// field.
pub fn carried_text() -> Option<String> {
    let ids = carried();
    (!ids.is_empty()).then(|| ids.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_carry_scope_names_only_valid_distinct_ids_and_counts_the_rest() {
        let ids: Vec<String> = ["ed-1", "bad id", "ed-2", "ed-1", "gx1.a.b", "ed-3"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        assert!(carried().is_empty());
        {
            let _scope = carry(&ids, 5);
            assert_eq!(carried(), ["ed-1", "ed-2", "ed-3"]);
            // Two invalid, one repeated, and the five the caller dropped itself.
            assert_eq!(carried_dropped(), 8);
            assert_eq!(carried_text().as_deref(), Some("ed-1,ed-2,ed-3"));
        }
        assert!(carried().is_empty(), "the scope ended");
        assert_eq!(carried_text(), None);
        assert_eq!(carried_dropped(), 0);
    }

    #[test]
    fn a_carry_scope_keeps_the_newest_ids_when_there_are_too_many() {
        let ids: Vec<String> = (0..MAX_CARRIED + 5).map(|n| format!("ed-{n}")).collect();
        let _scope = carry(&ids, 0);
        let kept = carried();
        assert_eq!(kept.len(), MAX_CARRIED);
        assert_eq!(
            kept.first().map(String::as_str),
            Some("ed-5"),
            "the oldest went"
        );
        assert_eq!(
            kept.last().map(String::as_str),
            Some(&*format!("ed-{}", MAX_CARRIED + 4))
        );
        assert_eq!(carried_dropped(), 5);
    }

    #[test]
    fn carry_scopes_nest_and_stay_on_their_thread() {
        let outer = vec!["ed-outer".to_owned()];
        let inner = vec!["ed-inner".to_owned()];
        let _outer = carry(&outer, 0);
        {
            let _inner = carry(&inner, 0);
            assert_eq!(carried(), ["ed-inner"]);
        }
        assert_eq!(carried(), ["ed-outer"]);
        std::thread::spawn(|| assert!(carried().is_empty()))
            .join()
            .expect("another thread sees none");
    }

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
