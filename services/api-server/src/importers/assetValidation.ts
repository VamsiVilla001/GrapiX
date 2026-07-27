import path from "node:path";

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "webp", "svg", "tif", "tiff",
  "ttf", "otf", "woff", "woff2", "wgsl",
  "mp4", "mov", "webm",
  "glb", "gltf", "json"
]);

export function validateImportedAsset(bytes: Buffer, fileName: string): string[] {
  const errors: string[] = [];
  const baseName = path.basename(fileName);
  const extension = path.extname(baseName).slice(1).toLowerCase();

  if (baseName !== fileName || fileName.includes("/") || fileName.includes("\\")) {
    errors.push("fileName must be a base name without directory components");
  }
  if (!/^[\w .()@+-]{1,180}$/u.test(baseName)) {
    errors.push("fileName contains unsafe characters or is too long");
  }
  if (!bytes.length) errors.push("file is empty");
  if (bytes.length > MAX_IMPORT_BYTES) errors.push("file exceeds the 50 MiB direct-import limit");
  if (extension === "aep") {
    errors.push(".aep projects cannot execute at runtime; use Lottie, alpha video, image sequence, or structured conversion");
  } else if (!ALLOWED_EXTENSIONS.has(extension)) {
    errors.push(`.${extension || "unknown"} is not an allowed GrapiX import type`);
  }
  if (extension && !matchesMagic(bytes, extension)) {
    errors.push(`file content does not match the .${extension} extension`);
  }
  return errors;
}

function matchesMagic(bytes: Buffer, extension: string): boolean {
  if (bytes.length < 12 && !["svg", "wgsl", "gltf", "json"].includes(extension)) {
    return false;
  }
  switch (extension) {
    case "png":
      return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "jpg":
    case "jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8;
    case "webp":
      return bytes.subarray(0, 4).toString("ascii") === "RIFF"
        && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    case "glb":
      return bytes.subarray(0, 4).toString("ascii") === "glTF";
    case "woff":
      return bytes.subarray(0, 4).toString("ascii") === "wOFF";
    case "woff2":
      return bytes.subarray(0, 4).toString("ascii") === "wOF2";
    case "ttf":
      return bytes.readUInt32BE(0) === 0x00010000 || bytes.subarray(0, 4).toString("ascii") === "true";
    case "otf":
      return bytes.subarray(0, 4).toString("ascii") === "OTTO";
    case "mp4":
    case "mov":
      return bytes.subarray(4, 8).toString("ascii") === "ftyp";
    case "webm":
      return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    case "svg":
    case "wgsl":
    case "gltf":
    case "json":
    case "tif":
    case "tiff":
      return true;
    default:
      return false;
  }
}
