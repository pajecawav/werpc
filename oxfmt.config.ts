import { defineOxfmtConfig } from "@pajecawav/tools";

export default defineOxfmtConfig({
	ignorePatterns: ["dist", "pnpm-lock.yaml", "coverage"],
});
