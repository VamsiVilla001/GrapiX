/**
 * Regenerates the importer test fixtures.
 *
 *   node scripts/make-fixtures.mjs
 *
 * Fixtures are committed so tests do not depend on binary assets from a designer, and so a
 * failing importer can be reproduced exactly. The PDF stands in for an Illustrator file
 * saved with "Create PDF Compatible File", which is what the AI importer actually reads.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writePsd } from "ag-psd";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, "..", "test-fixtures");

await mkdir(fixtureDir, { recursive: true });

// ---------------------------------------------------------------------------
// PDF fixture: a filled rect, a stroked line and a text run, wrapped in named
// optional content groups so layer-name recovery is exercised.
// ---------------------------------------------------------------------------

function buildPdf() {
  const content = [
    "/OC /OC1 BDC",
    "0.13 0.78 0.85 rg",
    "40 40 320 90 re f",
    "1 0.8 0.26 RG",
    "4 w",
    "40 150 m 360 150 l S",
    "EMC",
    "/OC /OC2 BDC",
    "0 0 0 rg",
    "BT /F1 28 Tf 48 170 Td (GrapiX Lower Third) Tj ET",
    "EMC"
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [6 0 R 7 0 R] /D << /ON [6 0 R 7 0 R] >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 5 0 R >> /Properties << /OC1 6 0 R /OC2 7 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /OCG /Name (Background) >>",
    "<< /Type /OCG /Name (Headline {{scorer.name}} @fit) >>"
  ];

  let pdf = "%PDF-1.5\n";
  const offsets = [];

  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;

  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }

  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

const pdfPath = path.join(fixtureDir, "lower-third.pdf");
await writeFile(pdfPath, buildPdf());
console.log(`wrote ${path.relative(process.cwd(), pdfPath)}`);

// ---------------------------------------------------------------------------
// PSD fixture: a group holding a solid shape and a tokenised text layer.
// ---------------------------------------------------------------------------

/**
 * ag-psd derives written layer bounds from pixel data, so a layer with no imageData is
 * saved with a zero-size box. Real designer files always carry pixels; the fixture has to
 * as well, or it exercises the importer's degenerate-bounds path instead of the normal one.
 */
function solidImageData(width, height, [r, g, b, a = 255]) {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let index = 0; index < data.length; index += 4) {
    data[index] = r;
    data[index + 1] = g;
    data[index + 2] = b;
    data[index + 3] = a;
  }

  return { width, height, data };
}

const psd = {
  width: 1920,
  height: 1080,
  children: [
    {
      name: "Lower Third",
      opacity: 1,
      blendMode: "normal",
      children: [
        {
          name: "Bar",
          left: 120,
          top: 820,
          right: 1080,
          bottom: 940,
          opacity: 1,
          blendMode: "normal",
          vectorFill: { type: "color", color: { r: 33, g: 199, b: 217 } },
          imageData: solidImageData(960, 120, [33, 199, 217])
        },
        {
          name: "Scorer {{scorer.name}} @fit",
          left: 160,
          top: 845,
          right: 1040,
          bottom: 915,
          opacity: 1,
          blendMode: "normal",
          text: {
            text: "MAYA CHEN",
            style: {
              font: { name: "Helvetica" },
              fontSize: 48,
              fillColor: { r: 255, g: 255, b: 255 },
              allCaps: true
            },
            paragraphStyle: { justification: "left" }
          },
          imageData: solidImageData(880, 70, [255, 255, 255])
        }
      ]
    },
    {
      name: "Sponsor #sponsor_slot",
      left: 1500,
      top: 60,
      right: 1820,
      bottom: 200,
      opacity: 0.8,
      blendMode: "multiply",
      imageData: solidImageData(320, 140, [255, 204, 0])
    }
  ]
};

const psdPath = path.join(fixtureDir, "lower-third.psd");
await writeFile(psdPath, Buffer.from(writePsd(psd, { generateThumbnail: false, noBackground: true })));
console.log(`wrote ${path.relative(process.cwd(), psdPath)}`);
