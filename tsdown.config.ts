import { defineConfig } from "tsdown";

export default defineConfig({
	entry: "./src/index.ts",
	platform: "browser",
	sourcemap: true,
	dts: true,
	tsconfig: "./tsconfig.lib.json",
});
