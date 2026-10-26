import { report } from './env.ts';

type Listener = (...args: never[]) => void;
const NONE = Object.freeze([]) as readonly never[]; // checks with and without strict mode (games vendor this file)

/**
 * Typed events: on(name, fn) and off(name, fn). The listener list is replaced on every change,
 * so emitting never allocates and a listener may remove itself while it runs. A listener that
 * throws is reported, and the others still run.
 */
export class Emitter<E extends { [K in keyof E]: Listener }> {
  private handlers: Partial<Record<keyof E, readonly Listener[]>> = {};

  on<K extends keyof E>(name: K, fn: E[K]): this {
    this.handlers[name] = [...(this.handlers[name] ?? NONE), fn];
    return this;
  }

  off<K extends keyof E>(name: K, fn: E[K]): this {
    const list = this.handlers[name];
    if (list) this.handlers[name] = list.filter((f) => f !== fn);
    return this;
  }

  protected listeners<K extends keyof E>(name: K): readonly E[K][] {
    return (this.handlers[name] ?? NONE) as readonly E[K][];
  }

  protected emit<K extends keyof E>(name: K, ...args: Parameters<E[K]>): void {
    for (const fn of this.listeners(name)) {
      try {
        (fn as (...a: Parameters<E[K]>) => void)(...args);
      } catch (error) {
        report(error);
      }
    }
  }
}
