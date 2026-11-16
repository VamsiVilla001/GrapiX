//! What a front end may put in its shell's log (build-plan row 2.13, ADR-0004
//! §6), and how a shell takes the correlation id of a call.
//!
//! A front end is a web page. Its code is ours, but what it holds (an error's
//! text, a console message) can come from anywhere, and what reaches a log is
//! evidence for as long as the file lives. So a front end does not write to the
//! log: it asks its shell to, through one command, and the shell writes only
//! what passes here. Only four kinds exist ([`KINDS`]); the level of three is
//! fixed by the kind; an id is checked and replaced if it is not plain; every
//! free-text field is cut to a bound; a `gx1.` credential found in text is
//! replaced; a field that is not listed is refused, not ignored.

use serde::Deserialize;

use crate::corr::{self, Adopted, Scope};

/// The request header the front end carries a call's correlation id in.
pub const CORR_HEADER: &str = "x-gx-corr";

/// The kinds of entry a front end may write.
pub const KINDS: [&str; 4] = ["ui.call", "ui.error", "ui.rejection", "ui.console"];

/// Longest `message`, in characters.
pub const MAX_MESSAGE: usize = 2_000;
/// Longest `stack` and `source`, in characters.
pub const MAX_STACK: usize = 4_000;

/// One entry from a front end. Every field is optional but `kind`; an unknown
/// field refuses the whole entry.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiEntry {
    /// One of [`KINDS`].
    pub kind: String,
    /// `debug` or `info`, honoured for `ui.call` only (a status poll is debug).
    #[serde(default)]
    pub level: Option<String>,
    /// The id of the call this reports, or of the error itself.
    #[serde(default)]
    pub corr: Option<String>,
    /// The shell command a `ui.call` was a call to.
    #[serde(default)]
    pub command: Option<String>,
    /// `ok`, or the error's code.
    #[serde(default)]
    pub result: Option<String>,
    /// How long the call took, in milliseconds.
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub message: Option<String>,
    /// Where an uncaught error came from (`file:line:column`).
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub stack: Option<String>,
}

/// Why an entry was not written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UiRefusal {
    /// The kind is not one of [`KINDS`].
    UnknownKind,
}

impl std::fmt::Display for UiRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownKind => write!(f, "a front-end log entry's kind must be one of {KINDS:?}"),
        }
    }
}

impl std::error::Error for UiRefusal {}

/// Take the id of an incoming shell call from its header and enter it for the
/// call. A call with no header, or one whose id is not plain, still gets an id
/// (the shell mints it): every shell call can be followed. A refused id is on
/// record by name and without its text.
pub fn enter_call(header: Option<&str>, command: &str) -> Scope {
    let adopted = corr::adopt(header, "shell");
    if let Adopted::Replaced(id) = &adopted {
        tracing::warn!(
            event = "corr.rejected",
            origin = "shell",
            command = plain_command(command),
            corr = id.as_str(),
        );
    }
    corr::enter(adopted.id())
}

/// Write one front-end entry to the log, or say why not.
pub fn record(entry: UiEntry) -> Result<(), UiRefusal> {
    let kind = KINDS
        .iter()
        .find(|known| **known == entry.kind)
        .copied()
        .ok_or(UiRefusal::UnknownKind)?;
    let adopted = corr::adopt(entry.corr.as_deref(), "ui");
    let replaced = adopted.was_replaced();
    let id = adopted.id();
    let command = entry.command.as_deref().and_then(plain_command);
    let result = entry
        .result
        .as_deref()
        .map(|result| if is_token(result) { result } else { "invalid" });
    let (message, message_cut) = bounded(entry.message.as_deref(), MAX_MESSAGE);
    let (source, _) = bounded(entry.source.as_deref(), MAX_STACK);
    let (stack, stack_cut) = bounded(entry.stack.as_deref(), MAX_STACK);
    let truncated = message_cut || stack_cut;
    let (message, source, stack) = (message.as_deref(), source.as_deref(), stack.as_deref());
    let duration_ms = entry.duration_ms;

    macro_rules! write {
        ($level:expr) => {
            tracing::event!(
                $level,
                event = kind,
                corr = id,
                command,
                result,
                duration_ms,
                message,
                source,
                stack,
                truncated,
                corr_replaced = replaced,
            )
        };
    }
    match (kind, entry.level.as_deref()) {
        ("ui.call", Some("debug")) => write!(tracing::Level::DEBUG),
        ("ui.call", _) => write!(tracing::Level::INFO),
        ("ui.console", _) => write!(tracing::Level::WARN),
        _ => write!(tracing::Level::ERROR),
    }
    Ok(())
}

/// A shell command's name if it is a plain one (`cmd_take`), else nothing.
fn plain_command(command: &str) -> Option<&str> {
    let plain = !command.is_empty()
        && command.len() <= 64
        && command.starts_with(|c: char| c.is_ascii_lowercase())
        && command
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    plain.then_some(command)
}

/// A short word of letters, digits, `_`, `:` and `-`: a result code.
fn is_token(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 64
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'-'))
}

/// `text` cut to `max` characters, with any `gx1.` credential in it replaced,
/// and whether it was cut.
fn bounded(text: Option<&str>, max: usize) -> (Option<String>, bool) {
    let Some(text) = text else {
        return (None, false);
    };
    let scrubbed = scrub_credentials(text);
    if scrubbed.chars().count() <= max {
        return (Some(scrubbed), false);
    }
    (Some(scrubbed.chars().take(max).collect()), true)
}

/// Replace every `gx1.<token characters>` run with `[redacted]`: a credential
/// that ended up in an error's text is not written.
fn scrub_credentials(text: &str) -> String {
    const MARK: &str = "gx1.";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(MARK) {
        out.push_str(&rest[..at]);
        out.push_str(crate::REDACTION_MARKER);
        let after = &rest[at + MARK.len()..];
        let end = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
            .unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sink::{start, LogConfig};
    use tracing_subscriber::layer::SubscriberExt;

    fn logged(label: &str, body: impl FnOnce()) -> Vec<serde_json::Value> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("gx-ui-{label}-{}-{nanos}", std::process::id()));
        let guard = start(LogConfig::new("editor", "shell", &dir)).unwrap();
        let subscriber = tracing_subscriber::registry().with(guard.layer());
        tracing::subscriber::with_default(subscriber, body);
        guard.finish().unwrap();
        let mut records = Vec::new();
        for entry in std::fs::read_dir(dir.join("editor")).unwrap().flatten() {
            for line in std::fs::read_to_string(entry.path()).unwrap().lines() {
                records.push(serde_json::from_str(line).unwrap());
            }
        }
        let _ = std::fs::remove_dir_all(dir);
        records
    }

    fn entry(json: serde_json::Value) -> UiEntry {
        serde_json::from_value(json).expect("an entry")
    }

    #[test]
    fn a_calls_end_is_written_with_its_id_command_result_and_duration_and_never_arguments() {
        let records = logged("call", || {
            record(entry(serde_json::json!({
                "kind": "ui.call", "corr": "ed-1a-7", "command": "cmd_take",
                "result": "ok", "durationMs": 12,
            })))
            .unwrap();
            record(entry(serde_json::json!({
                "kind": "ui.call", "corr": "ed-1a-8", "command": "cmd_status",
                "result": "ok", "durationMs": 1, "level": "debug",
            })))
            .unwrap();
        });
        let calls: Vec<_> = records.iter().filter(|r| r["event"] == "ui.call").collect();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["corr"], "ed-1a-7");
        assert_eq!(calls[0]["level"], "info");
        assert_eq!(calls[0]["fields"]["command"], "cmd_take");
        assert_eq!(calls[0]["fields"]["result"], "ok");
        assert_eq!(calls[0]["fields"]["duration_ms"], 12);
        assert_eq!(calls[1]["level"], "debug", "a poll is written at debug");
    }

    #[test]
    fn an_error_has_a_level_of_its_kind_not_of_its_say_so() {
        let records = logged("level", || {
            for kind in ["ui.error", "ui.rejection", "ui.console"] {
                record(entry(serde_json::json!({
                    "kind": kind, "level": "debug", "message": "boom",
                })))
                .unwrap();
            }
        });
        let level =
            |kind: &str| records.iter().find(|r| r["event"] == kind).unwrap()["level"].clone();
        assert_eq!(level("ui.error"), "error");
        assert_eq!(level("ui.rejection"), "error");
        assert_eq!(level("ui.console"), "warn");
    }

    #[test]
    fn an_entry_of_another_kind_or_with_another_field_is_refused() {
        assert_eq!(
            record(entry(serde_json::json!({ "kind": "operator.take" }))),
            Err(UiRefusal::UnknownKind)
        );
        assert_eq!(record(UiEntry::default()), Err(UiRefusal::UnknownKind));
        let unknown: Result<UiEntry, _> = serde_json::from_value(serde_json::json!({
            "kind": "ui.call", "token": "gx1.a.b",
        }));
        assert!(
            unknown.is_err(),
            "a field that is not listed is refused, not ignored"
        );
    }

    #[test]
    fn what_is_not_plain_is_replaced_cut_or_dropped_and_no_credential_is_written() {
        let long = "x".repeat(MAX_MESSAGE + 500);
        let token = "gx1.eyJzdWIiOiJvcCJ9.0123456789abcdef";
        let records = logged("scrub", || {
            record(entry(serde_json::json!({
                "kind": "ui.error",
                "corr": "has a space",
                "command": "cmd_take\nINJECTED",
                "result": "bad result!",
                "message": format!("connect failed with {token} then {long}"),
                "stack": format!("at connect ({token})"),
            })))
            .unwrap();
        });
        let text = records.iter().map(|r| r.to_string()).collect::<String>();
        assert!(
            !text.contains("0123456789abcdef") && !text.contains("eyJzdWI"),
            "a credential was written"
        );
        let error = records.iter().find(|r| r["event"] == "ui.error").unwrap();
        assert!(!error["corr"].as_str().unwrap().contains(' '));
        assert_eq!(error["fields"]["corr_replaced"], true);
        assert!(
            error["fields"]["command"].is_null(),
            "a command that is not plain is dropped"
        );
        assert_eq!(error["fields"]["result"], "invalid");
        assert_eq!(error["fields"]["truncated"], true);
        assert_eq!(
            error["fields"]["message"].as_str().unwrap().chars().count(),
            MAX_MESSAGE
        );
        assert!(error["fields"]["message"]
            .as_str()
            .unwrap()
            .starts_with(&format!("connect failed with {}", crate::REDACTION_MARKER)));
    }

    #[test]
    fn a_shell_call_has_an_id_whatever_the_front_end_sent() {
        let records = logged("enter", || {
            {
                let _kept = enter_call(Some("ed-1a-7"), "cmd_take");
                assert_eq!(corr::current().as_deref(), Some("ed-1a-7"));
            }
            {
                let _minted = enter_call(None, "cmd_take");
                assert!(corr::current().unwrap().starts_with("shell-"));
            }
            {
                let _replaced = enter_call(Some("gx1.token.mac"), "cmd_take");
                assert!(corr::current().unwrap().starts_with("shell-"));
            }
            assert_eq!(corr::current(), None);
        });
        let rejected: Vec<_> = records
            .iter()
            .filter(|r| r["event"] == "corr.rejected")
            .collect();
        assert_eq!(rejected.len(), 1, "{records:#?}");
        assert_eq!(rejected[0]["fields"]["command"], "cmd_take");
        let text = records.iter().map(|r| r.to_string()).collect::<String>();
        assert!(!text.contains("gx1.token"), "the refused id was kept");
    }

    #[test]
    fn credentials_are_replaced_wherever_they_sit_and_nothing_else_is() {
        assert_eq!(
            scrub_credentials("a gx1.abc.def_ghi-1 b gx1.zzz"),
            format!("a {m} b {m}", m = crate::REDACTION_MARKER)
        );
        assert_eq!(
            scrub_credentials("nothing here, not even gx1"),
            "nothing here, not even gx1"
        );
        assert_eq!(scrub_credentials("gx1."), crate::REDACTION_MARKER);
    }
}
