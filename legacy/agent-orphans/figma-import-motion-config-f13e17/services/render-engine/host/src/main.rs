//! gx-engine-host
//!
//! Status: **Planned**. Skeleton only: no implementation, and nothing here
//! claims otherwise (docs/README.md status vocabulary).
//!
//! Persistent single-instance supervisor. Owns the machine-wide lock, restarts the worker with bounded backoff, journals Program mutations, and restores output-inhibited.

#![forbid(unsafe_code)]

fn main() {
    eprintln!("gx-engine-host: Planned. Not implemented.");
    std::process::exit(78); // EX_CONFIG: configured, not runnable yet.
}
