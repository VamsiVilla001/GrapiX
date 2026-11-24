// The GrapiX wordmark is drawn by two stylesheets (Editor `.mark`/`.product`, Playout
// `.bar__mark`/`.bar__mark strong`). The brand sheet fixes one look, so a change to one
// must not leave the other behind: this compares the declarations that make the look.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8").replace(/\r\n/g, "\n");

/** The declarations of the first rule whose selector is exactly `selector`, as a map. */
function rule(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `no rule for ${selector}`);
  const out = {};
  for (const d of m[1].replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const i = d.indexOf(":");
    if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  }
  return out;
}

const editor = read("Editor/web/style.css");
const playout = read("Playout/web/style.css");

test("the wordmark has the same face, size, weight and case in both apps", () => {
  const a = rule(editor, ".mark");
  const b = rule(playout, ".bar__mark");
  for (const k of ["font-family", "font-size", "font-weight", "letter-spacing", "text-transform"]) {
    assert.equal(a[k], b[k], `wordmark ${k} differs`);
  }
  // Editor names the token directly; Playout aliases it as --ink (`--ink: var(--sk-ink)`).
  assert.equal(a.color, "var(--sk-ink)");
  assert.match(playout, /--ink:\s*var\(--sk-ink\);/);
  assert.equal(b.color, "var(--ink)");
  assert.equal(a["font-family"], "var(--sk-font-display)");
  assert.equal(a["font-weight"], "800");
});

test("the product name beside it matches too, and is never all capitals", () => {
  const a = rule(editor, ".product");
  const b = rule(playout, ".bar__mark strong");
  for (const k of ["font-size", "font-weight", "letter-spacing"]) {
    assert.equal(a[k], b[k], `product ${k} differs`);
  }
  assert.equal(a["text-transform"], "none");
});

test("no later rule overrides the Editor wordmark", () => {
  assert.equal(/\.brand\s+\.(mark|product)\s*\{/.test(editor), false);
});

test("both pages spell the name GrapiX", () => {
  assert.match(read("Editor/web/index.html"), /<span class="mark">GrapiX<\/span>/);
  assert.match(read("Playout/web/index.html"), /<h1 class="bar__mark">GrapiX </);
});
