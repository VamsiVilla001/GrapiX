// The Playout application entry point.
//
// Windows release builds hide the console for the same reason the Editor does.
// Debug builds keep it: an operator surface that refuses a take needs its
// diagnostics visible while it is being built.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![forbid(unsafe_code)]

fn main() {
    gx_playout_shell::run();
}
