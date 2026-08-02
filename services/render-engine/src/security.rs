//! Engine security.
//!
//! A daemon on loopback can assume its caller is trustworthy. A render engine on
//! a venue network cannot, and requirement 27 lists what that means.
//!
//! The absolute rules, which nothing in this module may weaken:
//!
//! 1. A remote client can never supply an unrestricted filesystem path. Paths are
//!    relative, traversal-free, and resolved inside a configured root — and
//!    re-checked *after* canonicalisation, because a symlink defeats any amount of
//!    string analysis.
//! 2. A remote client can never cause arbitrary shader or OS code to execute.
//! 3. Every limit is enforced, not merely configured.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::EngineConfig;

// ---------------------------------------------------------------------------
// Path restriction
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PathRejection {
    Empty,
    NullByte,
    Absolute,
    ParentTraversal,
    UrlScheme,
    NoRootsConfigured,
    /// Resolved, but landed outside every configured root — a symlink escape.
    OutsideRoots,
    NotFound,
}

impl PathRejection {
    pub fn message(&self) -> &'static str {
        match self {
            PathRejection::Empty => "asset path is empty",
            PathRejection::NullByte => "asset path contains a null byte",
            PathRejection::Absolute => "asset path must be relative to a configured root",
            PathRejection::ParentTraversal => "asset path must not contain a parent traversal",
            PathRejection::UrlScheme => "asset path must not be a URL or a drive-qualified path",
            PathRejection::NoRootsConfigured => "no asset roots are configured",
            PathRejection::OutsideRoots => {
                "asset path resolved outside every configured root, which indicates a symlink escape"
            }
            PathRejection::NotFound => "asset path does not exist inside any configured root",
        }
    }
}

/// Syntactic pre-check on a client-supplied path.
///
/// Cheap and runs first. It is *not* sufficient on its own — see
/// [`resolve_asset_path`], which repeats the containment check after asking the
/// filesystem.
pub fn check_path_syntax(candidate: &str) -> Result<(), PathRejection> {
    if candidate.trim().is_empty() {
        return Err(PathRejection::Empty);
    }
    if candidate.contains('\0') {
        return Err(PathRejection::NullByte);
    }

    // `file:`, `http:`, `\\?\`, and `C:` all land here.
    let scheme_like = candidate.split_once(':').is_some_and(|(prefix, _)| {
        !prefix.is_empty()
            && prefix.chars().next().is_some_and(char::is_alphabetic)
            && prefix
                .chars()
                .all(|c| c.is_alphanumeric() || c == '+' || c == '.' || c == '-')
    });
    if scheme_like {
        return Err(PathRejection::UrlScheme);
    }

    if candidate.starts_with('/') || candidate.starts_with('\\') {
        return Err(PathRejection::Absolute);
    }

    let path = Path::new(candidate);
    for component in path.components() {
        match component {
            Component::ParentDir => return Err(PathRejection::ParentTraversal),
            Component::RootDir | Component::Prefix(_) => return Err(PathRejection::Absolute),
            _ => {}
        }
    }

    Ok(())
}

/// Resolve a client-supplied path inside the configured roots.
///
/// Two-stage on purpose:
///
/// 1. syntactic check, so obvious attacks never touch the filesystem;
/// 2. canonicalise and confirm the *real* path is still inside a root.
///
/// The second stage is the one that matters. `assets/link` may be a symlink to
/// `/etc`, and no amount of string inspection can see that.
pub fn resolve_asset_path(candidate: &str, roots: &[PathBuf]) -> Result<PathBuf, PathRejection> {
    check_path_syntax(candidate)?;

    if roots.is_empty() {
        return Err(PathRejection::NoRootsConfigured);
    }

    for root in roots {
        let joined = root.join(candidate);

        let Ok(resolved) = joined.canonicalize() else {
            continue;
        };

        // The root itself must canonicalise, or containment is meaningless.
        let Ok(canonical_root) = root.canonicalize() else {
            continue;
        };

        if resolved.starts_with(&canonical_root) {
            return Ok(resolved);
        }

        // Resolved but outside: a symlink pointing out of the sandbox.
        return Err(PathRejection::OutsideRoots);
    }

    Err(PathRejection::NotFound)
}

/// Is a URL permitted for asset fetching?
///
/// Off unless explicitly enabled *and* the host is allowlisted. An engine that
/// fetches arbitrary URLs is a proxy sitting inside the production network.
pub fn check_fetch_url(url: &str, config: &EngineConfig) -> Result<(), String> {
    if !config.assets.allow_http_fetch {
        return Err("asset fetching over HTTP is disabled".to_string());
    }

    let lowered = url.to_ascii_lowercase();
    if !(lowered.starts_with("https://") || lowered.starts_with("http://")) {
        return Err("only http and https URLs may be fetched".to_string());
    }

    if config.assets.http_allowlist.is_empty() {
        return Err("no HTTP hosts are allowlisted".to_string());
    }

    let host = lowered
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or_default();

    if config
        .assets
        .http_allowlist
        .iter()
        .any(|allowed| host == allowed.to_ascii_lowercase())
    {
        return Ok(());
    }

    Err(format!("host {host} is not in assets.http-allowlist"))
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/// Token-bucket rate limiter.
///
/// Protects a live renderer from a client that loops on `preview.request`. Bursty
/// by design: an operator cueing several scenes at once is legitimate, a thousand
/// previews a second is not.
#[derive(Debug, Clone)]
pub struct RateLimiter {
    capacity: f64,
    refill_per_second: f64,
    tokens: f64,
    last_refill_ms: u64,
}

impl RateLimiter {
    pub fn new(capacity: u32, refill_per_second: u32, now_ms: u64) -> Self {
        Self {
            capacity: f64::from(capacity.max(1)),
            refill_per_second: f64::from(refill_per_second),
            tokens: f64::from(capacity.max(1)),
            last_refill_ms: now_ms,
        }
    }

    pub fn available(&self) -> f64 {
        self.tokens
    }

    /// Consume a token. False means the caller must be rejected.
    pub fn try_consume(&mut self, now_ms: u64, cost: f64) -> bool {
        self.refill(now_ms);
        if self.tokens < cost {
            return false;
        }
        self.tokens -= cost;
        true
    }

    /// Milliseconds until enough tokens exist.
    pub fn retry_after_ms(&mut self, now_ms: u64, cost: f64) -> u64 {
        self.refill(now_ms);
        if self.tokens >= cost {
            return 0;
        }
        if self.refill_per_second <= 0.0 {
            return u64::MAX;
        }
        (((cost - self.tokens) / self.refill_per_second) * 1000.0).ceil() as u64
    }

    fn refill(&mut self, now_ms: u64) {
        if now_ms <= self.last_refill_ms {
            return;
        }
        let elapsed_seconds = (now_ms - self.last_refill_ms) as f64 / 1000.0;
        self.tokens = (self.tokens + elapsed_seconds * self.refill_per_second).min(self.capacity);
        self.last_refill_ms = now_ms;
    }
}

// ---------------------------------------------------------------------------
// Message-id deduplication
// ---------------------------------------------------------------------------

/// Bounded message-id memory.
///
/// Retransmits must be recognised and discarded, but remembering every id an
/// engine has ever seen is a leak in a service meant to run for weeks. Capacity is
/// a hard ceiling, so memory is predictable regardless of traffic.
pub struct MessageDeduplicator {
    capacity: usize,
    ttl_ms: u64,
    seen: HashMap<String, u64>,
    order: Vec<String>,
}

impl MessageDeduplicator {
    pub fn new(capacity: usize, ttl_ms: u64) -> Self {
        Self {
            capacity: capacity.max(1),
            ttl_ms,
            seen: HashMap::new(),
            order: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.seen.len()
    }

    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }

    /// Record an id and report whether it had already been seen.
    ///
    /// True means "duplicate — acknowledge it and do nothing else".
    pub fn check(&mut self, message_id: &str, now_ms: u64) -> bool {
        self.expire(now_ms);

        if self.seen.contains_key(message_id) {
            self.seen.insert(message_id.to_string(), now_ms);
            return true;
        }

        self.seen.insert(message_id.to_string(), now_ms);
        self.order.push(message_id.to_string());

        while self.order.len() > self.capacity {
            let oldest = self.order.remove(0);
            self.seen.remove(&oldest);
        }

        false
    }

    pub fn clear(&mut self) {
        self.seen.clear();
        self.order.clear();
    }

    fn expire(&mut self, now_ms: u64) {
        if self.ttl_ms == 0 {
            return;
        }

        // Compare ages rather than against a cutoff timestamp. A cutoff computed
        // with `saturating_sub` clamps to zero early in the process lifetime, which
        // would expire an entry recorded at t=0 on its very first lookup.
        let ttl_ms = self.ttl_ms;
        let seen = &mut self.seen;
        self.order.retain(|id| match seen.get(id) {
            Some(at) if now_ms.saturating_sub(*at) <= ttl_ms => true,
            _ => {
                seen.remove(id);
                false
            }
        });
    }
}

// ---------------------------------------------------------------------------
// Sequence ordering
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SequenceVerdict {
    Accept,
    Duplicate,
    /// Arrived early. Park it.
    Future,
    /// Too far ahead to park. The stream is broken; resync.
    Gap,
}

/// Per-connection sequence ordering.
///
/// Ordered command handling is not optional: applying `Take` before the `Cue` it
/// depends on puts the wrong thing on air. When ordering cannot be guaranteed, the
/// correct answer is to resync, never to proceed.
pub struct SequenceTracker {
    next_expected: u64,
    park_limit: usize,
    parked: Vec<u64>,
    gaps: u64,
}

impl SequenceTracker {
    pub fn new(park_limit: usize) -> Self {
        Self {
            next_expected: 1,
            park_limit,
            parked: Vec::new(),
            gaps: 0,
        }
    }

    pub fn expected(&self) -> u64 {
        self.next_expected
    }

    pub fn gaps(&self) -> u64 {
        self.gaps
    }

    pub fn parked_count(&self) -> usize {
        self.parked.len()
    }

    pub fn classify(&self, sequence: u64) -> SequenceVerdict {
        if sequence == 0 {
            return SequenceVerdict::Gap;
        }
        if sequence < self.next_expected {
            return SequenceVerdict::Duplicate;
        }
        if sequence == self.next_expected {
            return SequenceVerdict::Accept;
        }
        if self.parked.len() >= self.park_limit {
            return SequenceVerdict::Gap;
        }
        SequenceVerdict::Future
    }

    /// Offer a sequence. Accepted ones return the run now unblocked.
    pub fn offer(&mut self, sequence: u64) -> (SequenceVerdict, Vec<u64>) {
        let verdict = self.classify(sequence);

        match verdict {
            SequenceVerdict::Duplicate => (verdict, Vec::new()),
            SequenceVerdict::Gap => {
                self.gaps += 1;
                self.parked.clear();
                (verdict, Vec::new())
            }
            SequenceVerdict::Future => {
                if !self.parked.contains(&sequence) {
                    self.parked.push(sequence);
                }
                (verdict, Vec::new())
            }
            SequenceVerdict::Accept => {
                let mut released = vec![sequence];
                self.next_expected = sequence + 1;

                loop {
                    if let Some(position) = self
                        .parked
                        .iter()
                        .position(|candidate| *candidate == self.next_expected)
                    {
                        released.push(self.parked.remove(position));
                        self.next_expected += 1;
                        continue;
                    }
                    break;
                }

                (verdict, released)
            }
        }
    }

    pub fn reset(&mut self) {
        self.next_expected = 1;
        self.parked.clear();
    }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct AuditEntry {
    pub at_ms: u64,
    pub client_id: String,
    pub message_type: String,
    /// Canonical scene identity, retained even for refused mutations so audit
    /// records cannot be ambiguous across projects or domains.
    #[serde(rename = "sceneRef", skip_serializing_if = "Option::is_none")]
    pub scene_ref: Option<crate::protocol::SceneRef>,
    pub outcome: String,
    /// Set when an operator deliberately overrode a safety gate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub override_reason: Option<String>,
}

/// Append-only audit log.
///
/// Every state-changing command is recorded, and so is every safety override. An
/// operator taking an unprepared scene online is a legitimate decision, but it has
/// to be an attributable one.
pub struct AuditLog {
    entries: Vec<AuditEntry>,
    limit: usize,
    path: Option<PathBuf>,
}

impl AuditLog {
    pub fn new(path: Option<PathBuf>, limit: usize) -> Self {
        Self {
            entries: Vec::new(),
            limit: limit.max(1),
            path,
        }
    }

    pub fn record(&mut self, entry: AuditEntry) {
        if let Some(path) = &self.path {
            if let Ok(line) = serde_json::to_string(&entry) {
                append_line(path, &line);
            }
        }

        self.entries.push(entry);
        if self.entries.len() > self.limit {
            self.entries.remove(0);
        }
    }

    pub fn recent(&self, limit: usize) -> &[AuditEntry] {
        let start = self.entries.len().saturating_sub(limit.max(1));
        &self.entries[start..]
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

fn append_line(path: &Path, line: &str) {
    use std::io::Write as _;

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        Ok(mut file) => {
            // A failed audit write must not take the renderer down, but it must be
            // visible: an audit log that silently stops is worse than none.
            if let Err(error) = writeln!(file, "{line}") {
                tracing::warn!(%error, path = %path.display(), "audit log write failed");
            }
        }
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "audit log could not be opened");
        }
    }
}

// ---------------------------------------------------------------------------
// Token comparison
// ---------------------------------------------------------------------------

/// Constant-time token comparison.
///
/// `==` on strings short-circuits at the first differing byte, which leaks the
/// length of a correct prefix to anyone who can time the response.
pub fn tokens_match(expected: &str, presented: &str) -> bool {
    let expected = expected.as_bytes();
    let presented = presented.as_bytes();

    // Compare a fixed number of bytes so the loop count does not depend on the
    // presented length either.
    let length = expected.len().max(presented.len());
    let mut difference = (expected.len() ^ presented.len()) as u8;

    for index in 0..length {
        let a = expected.get(index).copied().unwrap_or(0);
        let b = presented.get(index).copied().unwrap_or(0);
        difference |= a ^ b;
    }

    difference == 0
}
