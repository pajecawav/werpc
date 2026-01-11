import { describe, expect, it } from "vitest";
import { sum } from ".";

describe("sum", () => {
	it("defaults to 0", () => {
		expect(sum()).toBe(0);
	});

	it("adds values", () => {
		expect(sum(1, 5, 10, 20)).toBe(36);
	});
});
