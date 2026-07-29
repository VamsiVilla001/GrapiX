export interface MediaImportReport {
  container: "mp4/mov" | "webm";
  detectedCodecs: string[];
  hasAlpha: boolean | "unknown";
  colorSpace: "rec709" | "unknown";
  audio: "present" | "absent" | "unknown";
  productionReady: boolean;
  warnings: string[];
  requiredActions: string[];
}

export function inspectMediaImport(bytes: Buffer, fileName: string): MediaImportReport {
  const extension = fileName.toLowerCase().split(".").pop();
  const text = bytes.toString("latin1");
  const codecs = ["avc1", "hvc1", "hev1", "vp09", "av01", "ap4h", "ap4x"]
    .filter((codec) => text.includes(codec));
  const alphaCodec = codecs.some((codec) => codec === "ap4h" || codec === "ap4x");
  const container = extension === "webm" ? "webm" : "mp4/mov";
  const warnings: string[] = [];
  if (!codecs.length) warnings.push("Codec could not be identified from the container sample.");
  warnings.push("Native decoder and colour output are not yet hardware-certified on this machine.");
  return {
    container,
    detectedCodecs: codecs,
    hasAlpha: alphaCodec || extension === "webm" ? "unknown" : false,
    colorSpace: "unknown",
    audio: text.includes("soun") ? "present" : "unknown",
    productionReady: false,
    warnings,
    requiredActions: [
      "Run native ffprobe/decoder metadata extraction.",
      "Preroll and decode initial frames under the selected quality profile.",
      "Verify frame-rate conversion, alpha, Rec.709 levels, and hardware decoder limits."
    ]
  };
}
