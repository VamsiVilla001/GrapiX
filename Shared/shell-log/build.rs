//! The test binary of this crate runs Tauri's mock runtime, which on Windows
//! imports controls that exist only in Common Controls version 6. An app gets
//! that dependency from the manifest `tauri-build` embeds; a test binary has no
//! such manifest and does not start (`STATUS_ENTRYPOINT_NOT_FOUND`). This embeds
//! the same dependency. The crate is a library: the link argument reaches only
//! the binaries Cargo builds from it, its tests.

use std::path::PathBuf;

const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>
"#;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if !windows_msvc {
        return;
    }
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"))
        .join("common-controls.manifest");
    std::fs::write(&out, MANIFEST).expect("the manifest is written");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", out.display());
}
