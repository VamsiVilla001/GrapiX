// One-shot generator for the colour transfer reference table (11.4).
//
// Writes the reference values the TypeScript transfer curves must match,
// computed by the RUST implementations themselves (color.rs). This is the
// pin that makes "the browser matches the engine" provable rather than
// hopeful: the two curves are written in two languages, so without a shared
// reference they are the two implementations of one spec that invariant 27
// says will drift.
use gx_contracts::color::*;
fn main() {
    let mut out = String::from(
        "// GENERATED from the Rust contracts (color.rs) by tools/contract-codegen/src/bin/gen-colour.rs.\n// Do not edit. The reference the TypeScript transfer curves must match (11.4, invariant 27).\nexport const TRANSFER_REFERENCE = [\n");
    let steps = [0.0f64, 0.001, 0.0031308, 0.005, 0.018, 0.040449_936_474_468_28, 0.081, 0.1, 0.18, 0.25, 0.5, 0.75, 0.9, 0.99, 1.0];
    for &v in &steps {
        out.push_str(&format!(
            "  {{ x: {v:?}, srgbEncode: {:?}, srgbDecode: {:?}, rec709Encode: {:?}, rec709Decode: {:?} }},\n",
            srgb_encode(v), srgb_decode(v), rec709_encode(v), rec709_decode(v)
        ));
    }
    out.push_str("] as const;\n");
    std::fs::write(r"D:\Project KK\Personal projects\GrapiX\Editor\src\transfer-reference.ts", out)
        .expect("write reference");
    println!("wrote transfer-reference.ts");
}
