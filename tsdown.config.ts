import { defineConfig } from "tsdown";

export default defineConfig(cfg => ({
	entry: "./src/index.ts",
	platform: "browser",
	unbundle: true,
	sourcemap: true,
	dts: true,
	tsconfig: "./tsconfig.lib.json",
	clean: !cfg.watch,
}));
