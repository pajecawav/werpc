// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const expectNever = (_value: never): never => {
	throw new Error("Unexpected value");
};
