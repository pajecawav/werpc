export function sum(...values: number[]): number {
	let result = 0;

	for (const value of values) {
		result += value;
	}
	return result;
}
