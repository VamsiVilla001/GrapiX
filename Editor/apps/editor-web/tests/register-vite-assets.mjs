/** Registers `vite-asset-hooks.mjs`; passed to node with `--import`. */
import { register } from "node:module";

register("./vite-asset-hooks.mjs", import.meta.url);
