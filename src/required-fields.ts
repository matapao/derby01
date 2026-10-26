/** Construction phases can publish a complete object only after every attachment exists. */
export function requireFields<T, K extends keyof T>(
  value: T,
  keys: readonly K[],
): asserts value is T & Required<Pick<T, K>> {
  for (const key of keys) {
    if (value[key] === undefined || value[key] === null)
      throw new Error(`Missing constructed field: ${String(key)}`);
  }
}

/** Reject a missing required table entry before it becomes an invalid simulation or render value. */
export function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing required indexed value');
  return value;
}
