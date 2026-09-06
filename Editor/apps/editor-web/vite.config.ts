import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

/**
 * The Editor's build.
 *
 * ## Why the React Compiler is on
 *
 * This app memoises by hand where it measured a problem — `ObjectRow` is `memo`'d because an
 * un-memoised row cost 80 ms per arrow key at 199 rows — and nowhere else, because hand-memoising
 * everything is unreadable and goes stale the first time a prop is added. The compiler closes that
 * gap: it re-derives the memoisation for every component it can prove safe, so a panel nobody
 * profiled still stops re-rendering on state it does not read.
 *
 * ## Two things that are easy to get wrong here
 *
 * **Order.** The compiler runs *before* `react()`. Vite applies `transform` hooks in array order and
 * `react()` hands the file to oxc, which strips the types and rewrites the JSX; the compiler needs
 * the source shape.
 *
 * **Cost.** This routes every component file through Babel, which is slower than oxc — the build
 * reports most of its time in this plugin. That is the whole price, it is paid per changed file, and
 * it buys memoisation that hand-written `memo` only has where somebody remembered to add it.
 *
 * A file the compiler cannot prove safe is skipped, not miscompiled: `try/finally` bodies and a few
 * other shapes bail out and run exactly as they did before.
 */
export default defineConfig({
  base: "./",
  plugins: [
    babel({ presets: [reactCompilerPreset({ target: "19" })] }),
    react()
  ],
  server: {
    port: 5173
  }
});
