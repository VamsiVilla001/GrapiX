// Row 11.67 (the new Figma UI, 24 Nov 2026): the two apps share one set of SKWAD tokens and one type scale.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const editor = read("Editor/web/skwad.css");
const playout = read("Playout/web/skwad.css");

/** The value a custom property is given in the :root block of `css`. */
function token(css, name) {
  const match = css.match(new RegExp(`${name.replace(/[-]/g, "\\-")}:\\s*([^;]+);`));
  return match ? match[1].trim() : undefined;
}

test("both apps carry the same skwad.css", () => {
  assert.equal(playout, editor);
});

test("the colours the Figma file binds are the tokens", () => {
  const figma = {
    "--sk-canvas": "#131210", "--sk-surface": "#1B1916", "--sk-surface-2": "#24221E",
    "--sk-border": "#34312A", "--sk-border-strong": "#46423A",
    "--sk-ink": "#F2F0EB", "--sk-ink-2": "#D3CEC6", "--sk-ink-3": "#95908A", "--sk-ink-4": "#6E6A63",
    "--sk-ember": "#F58138", "--sk-ember-deep": "#F7A066", "--sk-ember-tint": "#2C1B11",
    "--sk-ok": "#5DB08A", "--sk-warn": "#DDA543", "--sk-danger": "#E06A5E",
    "--sk-brand-ember": "#F15A29", "--sk-brand-cream": "#F3EDE4", "--sk-brand-ink": "#1B0C10",
    "--sk-viewport": "#000000", "--sk-key": "#F58138",
    "--sk-radius-tag": "1px", "--sk-radius-control": "2px", "--sk-radius-cell": "3px",
    "--sk-space-1": "4px", "--sk-space-2": "8px", "--sk-space-3": "12px",
  };
  for (const [name, value] of Object.entries(figma)) assert.equal(token(editor, name)?.toUpperCase(), value.toUpperCase(), name);
});

test("the information blue, the on-air colours and the timeline bar are tokens", () => {
  for (const name of ["--sk-info", "--sk-info-tint", "--sk-info-ink", "--sk-onair-row", "--sk-onair-monitor", "--sk-track"]) {
    assert.match(token(editor, name) ?? "", /^#[0-9A-Fa-f]{6}$/, name);
  }
});

test("the ten type styles are the Figma sk styles", () => {
  const styles = {
    "--sk-text-body": "500 12px/16px", "--sk-text-body-strong": "600 12px/16px", "--sk-text-title": "600 13px/18px",
    "--sk-text-caption": "500 11px/14px", "--sk-text-label": "600 10px/12px", "--sk-text-wordmark": "800 18px/22px",
    "--sk-text-mono": "500 11px/16px", "--sk-text-mono-small": "400 10px/14px", "--sk-text-timecode": "700 12px/16px",
  };
  for (const [name, start] of Object.entries(styles)) assert.ok(token(editor, name)?.startsWith(start), `${name}: ${token(editor, name)}`);
  for (const cls of ["sk-body", "sk-body-strong", "sk-title", "sk-caption", "sk-label", "sk-wordmark", "sk-mono", "sk-mono-small", "sk-timecode"]) {
    assert.ok(editor.includes(`.${cls} {`), cls);
  }
  assert.equal(token(editor, "--sk-tracking-label"), "0.06em");
});

test("both apps read at 12 over 16, as the design does", () => {
  for (const file of ["Editor/web/style.css", "Playout/web/style.css"]) {
    const body = [...read(file).matchAll(/\nbody \{[^}]*\}/g)].map((m) => m[0]).find((b) => b.includes("font-family")) ?? "";
    assert.match(body, /font-size: 12px;/, file);
    assert.match(body, /line-height: 16px;/, file);
  }
});

test("Playout's information colour is the shared token, not a colour of its own", () => {
  const css = read("Playout/web/style.css");
  assert.match(css, /--info: var\(--sk-info\);/);
  assert.ok(!css.includes("#6fb3d9"));
});
