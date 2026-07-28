import assert from "node:assert/strict";
import test from "node:test";
import { parseFontStylesheet } from "../dist/fonts/cssFontParser.js";

test("parses Google-style multi-face CSS without executing unrelated rules", () => {
  const result = parseFontStylesheet(`
    @import url("./latin.css");
    body { background: url("https://evil.invalid/tracker"); }
    @font-face {
      font-family: "Broadcast Sans";
      font-style: normal;
      font-weight: 400 700;
      font-display: swap;
      src: local("Broadcast Sans"), url("./broadcast.woff2") format("woff2"),
           url("./broadcast.woff") format("woff");
      unicode-range: U+0000-00FF;
    }
    @font-face {
      font-family: 'Broadcast Sans';
      font-style: italic;
      font-weight: 700;
      src: url(https://cdn.example.com/broadcast-italic.otf) format(opentype);
    }
  `, "https://fonts.example.com/project/main.css");

  assert.deepEqual(result.imports, ["https://fonts.example.com/project/latin.css"]);
  assert.equal(result.faces.length, 2);
  assert.deepEqual(result.faces[0], {
    family: "Broadcast Sans",
    weight: 400,
    style: "normal",
    stretch: undefined,
    unicodeRange: "U+0000-00FF",
    sources: [
      { url: "https://fonts.example.com/project/broadcast.woff2", format: "woff2" },
      { url: "https://fonts.example.com/project/broadcast.woff", format: "woff" }
    ]
  });
  assert.equal(result.faces[1].style, "italic");
  assert.equal(result.faces[1].sources[0].format, "otf");
});

test("drops non-HTTPS imports and font sources", () => {
  const result = parseFontStylesheet(`
    @import "http://insecure.invalid/fonts.css";
    @font-face { font-family: Unsafe; src: url(file:///tmp/font.ttf); }
  `, "https://fonts.example.com/main.css");
  assert.deepEqual(result, { imports: [], faces: [] });
});
