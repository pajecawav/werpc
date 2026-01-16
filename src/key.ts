import { nanoid } from "nanoid/non-secure";

export const createIdempotencyKey = () => nanoid();
