//! Control-plane delivery semantics: ordered, acknowledged, sequenced, with
//! **no loss tolerance** (ADR-001).
//!
//! Two rules here are not design preferences. Each was a fault that wedged a
//! live connection in 1.x:
//!
//! - **Sequence handling runs before deduplication** (invariant 33). Dedup
//!   first will silently swallow a legitimate retransmission that arrives
//!   after a gap, and the caller waits forever for a reply it already had
//!   discarded.
//! - **Replies and events never share an id** (invariant 33), and a reply is
//!   recognised by its `reply.` prefix, never by an enumerated switch
//!   (invariant 34). An enumerated switch is how one unlisted reply kind came
//!   to hang every call for 15 seconds.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Monotonic per-direction message counter. Gaps mean loss, which the control
/// plane does not tolerate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub struct Sequence(pub u64);

impl Sequence {
    pub const FIRST: Self = Self(1);

    pub fn next(self) -> Self {
        Self(self.0.saturating_add(1))
    }
}

/// The prefix that makes a message a reply. Matching on this, rather than on a
/// list of known reply names, is what keeps an unrecognised reply kind from
/// falling through to a timeout.
pub const REPLY_PREFIX: &str = "reply.";

/// Message identity. Correlates a request with its reply.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub struct MessageId(pub String);

impl MessageId {
    /// Whether this is a reply, by prefix (invariant 34).
    pub fn is_reply(&self) -> bool {
        self.0.starts_with(REPLY_PREFIX)
    }

    /// What kind of traffic this id denotes. Derived, never declared
    /// separately: a second field saying "this is an event" could disagree
    /// with the id, and then two code paths would disagree about one message.
    pub fn kind(&self) -> MessageKind {
        if self.is_reply() {
            MessageKind::Reply
        } else {
            MessageKind::Event
        }
    }
}

impl std::fmt::Display for MessageId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Reply or event. They must never share an id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum MessageKind {
    Reply,
    Event,
}

/// What the receiver should do with an arriving message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    /// In order and not seen before. Process it.
    Accepted,
    /// Behind the watermark and already processed. Drop it, and do not treat
    /// it as loss.
    Duplicate,
    /// Ahead of the watermark: messages are missing. The control plane cannot
    /// lose messages, so this is a reconnect-and-reconcile condition, not
    /// something to process out of order.
    Gap { expected: Sequence, got: Sequence },
}

/// Tracks inbound sequence per direction.
///
/// Deliberately small and deliberately not a queue: it classifies, and the
/// caller decides. A tracker that buffered out-of-order messages would be
/// making a delivery-guarantee decision that belongs to the transport.
#[derive(Debug, Clone, Default)]
pub struct SequenceTracker {
    /// Highest sequence processed in order. `None` before the first message.
    watermark: Option<Sequence>,
}

impl SequenceTracker {
    pub fn new() -> Self {
        Self { watermark: None }
    }

    pub fn watermark(&self) -> Option<Sequence> {
        self.watermark
    }

    /// Classify an arriving sequence, advancing the watermark on acceptance.
    ///
    /// The ordering of the checks below *is* invariant 33: position relative
    /// to the watermark is established first, and only a message behind it is
    /// treated as a duplicate. Testing for duplicate first would classify the
    /// retransmission that fills a gap as one.
    pub fn admit(&mut self, seq: Sequence) -> Admission {
        let expected = match self.watermark {
            None => Sequence::FIRST,
            Some(w) => w.next(),
        };

        // 1. Sequence handling.
        if seq == expected {
            self.watermark = Some(seq);
            return Admission::Accepted;
        }
        if seq > expected {
            return Admission::Gap { expected, got: seq };
        }

        // 2. Only now, deduplication.
        Admission::Duplicate
    }
}

/// Rejects a message whose declared kind disagrees with its id.
///
/// The 1.x fault was a reply and an event carrying the same id; the connection
/// correlated the event to the pending request and the real reply was then
/// discarded as a duplicate.
pub fn check_kind(id: &MessageId, declared: MessageKind) -> Result<(), KindConflict> {
    let derived = id.kind();
    if derived == declared {
        Ok(())
    } else {
        Err(KindConflict {
            id: id.clone(),
            derived,
            declared,
        })
    }
}

/// An id that claims to be one kind of traffic and looks like another.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KindConflict {
    pub id: MessageId,
    pub derived: MessageKind,
    pub declared: MessageKind,
}

impl std::fmt::Display for KindConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "message {} looks like a {:?} but was declared a {:?}",
            self.id, self.derived, self.declared
        )
    }
}

impl std::error::Error for KindConflict {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_order_messages_are_accepted() {
        let mut t = SequenceTracker::new();
        for n in 1..=5 {
            assert_eq!(t.admit(Sequence(n)), Admission::Accepted);
        }
        assert_eq!(t.watermark(), Some(Sequence(5)));
    }

    #[test]
    fn a_replay_behind_the_watermark_is_a_duplicate() {
        let mut t = SequenceTracker::new();
        t.admit(Sequence(1));
        t.admit(Sequence(2));
        assert_eq!(t.admit(Sequence(2)), Admission::Duplicate);
        assert_eq!(t.admit(Sequence(1)), Admission::Duplicate);
        assert_eq!(
            t.watermark(),
            Some(Sequence(2)),
            "a duplicate never advances"
        );
    }

    #[test]
    fn a_gap_is_reported_as_loss_not_swallowed() {
        let mut t = SequenceTracker::new();
        t.admit(Sequence(1));
        assert_eq!(
            t.admit(Sequence(7)),
            Admission::Gap {
                expected: Sequence(2),
                got: Sequence(7)
            }
        );
        assert_eq!(
            t.watermark(),
            Some(Sequence(1)),
            "a gap must not advance the watermark past missing messages"
        );
    }

    #[test]
    fn the_retransmission_that_fills_a_gap_is_accepted_not_deduplicated() {
        // This is invariant 33. If dedup ran before sequence handling, the
        // resend of 2 below would be classified against a watermark that had
        // wrongly advanced, and dropped.
        let mut t = SequenceTracker::new();
        t.admit(Sequence(1));
        assert!(matches!(t.admit(Sequence(3)), Admission::Gap { .. }));
        assert_eq!(
            t.admit(Sequence(2)),
            Admission::Accepted,
            "the message that fills the gap must be processed"
        );
        assert_eq!(t.admit(Sequence(3)), Admission::Accepted);
    }

    #[test]
    fn replies_are_recognised_by_prefix_not_by_a_known_list() {
        // A reply kind nobody enumerated must still be recognised as a reply.
        let unheard_of = MessageId("reply.something.invented.tomorrow".to_string());
        assert!(unheard_of.is_reply());
        assert_eq!(unheard_of.kind(), MessageKind::Reply);
    }

    #[test]
    fn events_are_not_replies() {
        let event = MessageId("event.reference.lost".to_string());
        assert!(!event.is_reply());
        assert_eq!(event.kind(), MessageKind::Event);
    }

    #[test]
    fn a_reply_and_an_event_may_not_share_an_id() {
        let id = MessageId("reply.take".to_string());
        assert!(check_kind(&id, MessageKind::Reply).is_ok());
        let conflict = check_kind(&id, MessageKind::Event)
            .expect_err("an event carrying a reply id must be rejected");
        assert_eq!(conflict.derived, MessageKind::Reply);
        assert_eq!(conflict.declared, MessageKind::Event);
    }

    #[test]
    fn a_name_merely_containing_the_prefix_is_not_a_reply() {
        // `starts_with`, not `contains`: an event about replies is an event.
        let id = MessageId("event.about.reply.counts".to_string());
        assert!(!id.is_reply());
    }
}
