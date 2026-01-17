import { IDEMPOTENCY_KEY_TTL_MS } from "../constants";

export class IdempotencyManager {
	private seenKeys = new Set<string>();

	public isDuplicate(key: string): boolean {
		if (this.seenKeys.has(key)) {
			return true;
		}

		this.seenKeys.add(key);

		setTimeout(() => {
			this.seenKeys.delete(key);
		}, IDEMPOTENCY_KEY_TTL_MS);

		return false;
	}
}
