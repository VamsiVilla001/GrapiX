//! Chunked, verified, resumable transfer (ADR-001, ADR B.3).
//!
//! The asset plane tolerates no loss but is restartable, which is a different
//! guarantee from the control plane's. A 400MB package interrupted at 90% must
//! resume from chunk 90, not from the beginning, and must never be promoted to
//! a cached asset until its bytes have been verified (invariant 28).
//!
//! The ordering encoded here is the point: **verify, then promote.** A
//! truncated file in a content-addressed cache carries a name asserting that
//! it was verified, and every later reader trusts that name.

use gx_contracts::{ContentHash, Refusal};

use crate::TransferState;

/// Tracks one asset's chunked arrival, in order, with resume.
#[derive(Debug, Clone)]
pub struct Transfer {
    hash: ContentHash,
    total_chunks: u32,
    /// Chunks verified so far, contiguous from zero. Resume starts here.
    next_chunk: u32,
    state: TransferState,
}

impl Transfer {
    pub fn new(hash: ContentHash, total_chunks: u32) -> Result<Self, Refusal> {
        if total_chunks == 0 {
            return Err(Refusal::NotImplemented {
                what: "zero-chunk transfer".to_string(),
            });
        }
        Ok(Self {
            hash,
            total_chunks,
            next_chunk: 0,
            state: TransferState::Pending,
        })
    }

    pub fn hash(&self) -> &ContentHash {
        &self.hash
    }

    pub fn state(&self) -> TransferState {
        self.state
    }

    /// The chunk index a resumed transfer must start from.
    pub fn resume_from(&self) -> u32 {
        self.next_chunk
    }

    pub fn is_complete(&self) -> bool {
        self.next_chunk == self.total_chunks
    }

    /// Accept one chunk. Out-of-order chunks are refused rather than buffered:
    /// buffering would mean holding unverified bytes with nowhere to put them.
    pub fn accept_chunk(&mut self, index: u32) -> Result<(), Refusal> {
        if self.is_complete() {
            return Err(Refusal::NotImplemented {
                what: "chunk after completion".to_string(),
            });
        }
        if index != self.next_chunk {
            return Err(Refusal::FrameNotReachable {
                requested: u64::from(index),
                earliest: u64::from(self.next_chunk),
            });
        }
        self.next_chunk += 1;
        self.state = if self.is_complete() {
            // Complete is not yet verified. The distinction is the whole
            // safety property.
            TransferState::InProgress
        } else {
            TransferState::InProgress
        };
        Ok(())
    }

    /// Verify the assembled bytes against the declared hash.
    ///
    /// Must be called before promotion. On mismatch the transfer is poisoned:
    /// the bytes are discarded, not cached under a name claiming they were
    /// verified.
    pub fn verify(&mut self, computed: &ContentHash) -> Result<(), Refusal> {
        if !self.is_complete() {
            return Err(Refusal::AssetMissing {
                hash: self.hash.clone(),
            });
        }
        if computed == &self.hash {
            self.state = TransferState::Verified;
            Ok(())
        } else {
            self.state = TransferState::HashMismatch;
            Err(Refusal::AssetMissing {
                hash: self.hash.clone(),
            })
        }
    }

    /// Whether these bytes may be promoted into the content-addressed cache.
    ///
    /// Only a verified transfer may. This is the gate invariant 28 describes,
    /// expressed so that a caller cannot promote by accident: there is no way
    /// to ask for a path to write to without passing this first.
    pub fn may_promote(&self) -> bool {
        self.state == TransferState::Verified
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(s: &str) -> ContentHash {
        ContentHash(s.to_string())
    }

    fn transfer() -> Transfer {
        Transfer::new(hash("abc123"), 4).unwrap()
    }

    #[test]
    fn chunks_arrive_in_order_and_completion_is_not_verification() {
        let mut t = transfer();
        for i in 0..4 {
            t.accept_chunk(i).unwrap();
        }
        assert!(t.is_complete());
        assert!(
            !t.may_promote(),
            "complete bytes are not verified bytes: promotion must still be blocked"
        );
    }

    #[test]
    fn an_interrupted_transfer_resumes_from_the_next_chunk() {
        let mut t = transfer();
        t.accept_chunk(0).unwrap();
        t.accept_chunk(1).unwrap();
        // Connection drops here.
        assert_eq!(
            t.resume_from(),
            2,
            "resume by chunk, not from the beginning"
        );
        t.accept_chunk(2).unwrap();
        t.accept_chunk(3).unwrap();
        assert!(t.is_complete());
    }

    #[test]
    fn an_out_of_order_chunk_is_refused() {
        let mut t = transfer();
        t.accept_chunk(0).unwrap();
        let err = t.accept_chunk(3).expect_err("a skipped chunk must refuse");
        assert!(matches!(
            err,
            Refusal::FrameNotReachable { earliest: 1, .. }
        ));
        assert_eq!(
            t.resume_from(),
            1,
            "a refused chunk does not advance resume"
        );
    }

    #[test]
    fn a_hash_mismatch_poisons_the_transfer_and_blocks_promotion() {
        let mut t = transfer();
        for i in 0..4 {
            t.accept_chunk(i).unwrap();
        }
        let err = t
            .verify(&hash("something-else"))
            .expect_err("a mismatched hash must refuse");
        assert!(matches!(err, Refusal::AssetMissing { .. }));
        assert_eq!(t.state(), TransferState::HashMismatch);
        assert!(
            !t.may_promote(),
            "invariant 28: bytes that failed verification are never cached"
        );
    }

    #[test]
    fn verification_before_completion_is_refused() {
        let mut t = transfer();
        t.accept_chunk(0).unwrap();
        assert!(
            t.verify(&hash("abc123")).is_err(),
            "a partial transfer cannot be verified, whatever hash is offered"
        );
        assert!(!t.may_promote());
    }

    #[test]
    fn only_a_verified_transfer_may_promote() {
        let mut t = transfer();
        for i in 0..4 {
            t.accept_chunk(i).unwrap();
        }
        t.verify(&hash("abc123")).unwrap();
        assert_eq!(t.state(), TransferState::Verified);
        assert!(t.may_promote());
    }

    #[test]
    fn a_chunk_after_completion_is_refused() {
        let mut t = transfer();
        for i in 0..4 {
            t.accept_chunk(i).unwrap();
        }
        assert!(t.accept_chunk(4).is_err());
    }
}
