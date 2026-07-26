export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

export function hasOnlyKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

export function isString(value: unknown): value is string {
	return typeof value === "string";
}

export function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function isNullableString(value: unknown): boolean {
	return value === null || isString(value);
}

export function isNullableIndex(value: unknown): boolean {
	return value === null || isNonNegativeInteger(value);
}

export function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isString);
}
