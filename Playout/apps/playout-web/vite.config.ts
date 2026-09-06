import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { defineConfig } from "vite";

/**
 * The operator console's build.
 *
 * The React Compiler is on here for the same reason as the Editor, and it matters more: this app is
 * watched during a live show, and a re-render it did not need is a frame an operator waited for. The
 * compiler runs *before* `react()`, because `react()` hands the file to oxc and the compiler needs
 * the source shape rather than transformed JSX.
 */
export default defineConfig({
  base: "./",
  plugins: [
    babel({ presets: [reactCompilerPreset({ target: "19" })] }),
    react()
  ],
  server: {
    port: 5174,
    strictPort: true
  }
});
