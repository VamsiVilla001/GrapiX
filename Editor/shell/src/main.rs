// The Editor application entry point.
//
// Windows release builds get the `windows_subsystem` attribute so launching
// the Editor does not also open a console window behind it. Debug builds keep
// the console, because that is where a panic and the shell's own diagnostics
// are read during development.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![forbid(unsafe_code)]

fn main() {
    gx_editor_shell::run();
}
