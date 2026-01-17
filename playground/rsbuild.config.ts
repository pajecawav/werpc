import { defineConfig } from "@rsbuild/core";

export default defineConfig({
	source: {
		entry: {
			devtools: "./src/devtools.ts",
			devtoolsPanel: "./src/devtoolsPanel.ts",
			background: {
				import: "./src/background.ts",
				html: false,
			},
			options: "./src/options.ts",
			popup: "./src/popup.ts",
			content: "./src/content.ts",
			content2: "./src/content2.ts",
		},
	},
	output: {
		sourceMap: true,
		filenameHash: false,
		distPath: {
			js: "./",
			jsAsync: "./",
		},
		copy: ["./src/manifest.json"],
	},
	performance: {
		chunkSplit: {
			strategy: "all-in-one",
		},
	},
});
