import { defineOxlintConfig } from "@pajecawav/tools";

export default defineOxlintConfig({
	ignorePatterns: ["**/dist", "**/coverage"],
	rules: {
		"require-post-message-target-origin": "off",
	},
});
