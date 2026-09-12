#![forbid(unsafe_code)]

fn main() {
    let result = match std::env::args().nth(1).as_deref() {
        Some("capture") => gx_pixel_gate::capture(),
        Some("check") => gx_pixel_gate::check(),
        _ => {
            eprintln!("usage: gx-pixel-gate <capture|check>");
            std::process::exit(2);
        }
    };
    if let Err(error) = result {
        eprintln!("gx-pixel-gate: {error}");
        std::process::exit(1);
    }
}
