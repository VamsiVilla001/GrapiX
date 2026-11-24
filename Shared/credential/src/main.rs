//! `gx-credential mint`: see `gx_credential::cli`.
#![forbid(unsafe_code)]

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    match gx_credential::cli::run(&arguments, |name| std::env::var(name).ok()) {
        Ok(credential) => println!("{credential}"),
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    }
}
