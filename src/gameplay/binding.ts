/** An explicit composition-root dependency. Calling it before wiring is an error, not a silent no-op. */
export function requiredBinding<T>(name: string) {
  let value: T | undefined;
  return {
    bind(dependency: T): void {
      if (value !== undefined) throw new Error(`${name} is already bound`);
      value = dependency;
    },
    get(): T {
      if (value === undefined) throw new Error(`${name} must be bound before boot`);
      return value;
    },
  };
}
