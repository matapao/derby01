export const DROP_KINDS = ['fuel', 'tyre', 'bumper', 'glass'] as const;
export type DropKind = (typeof DROP_KINDS)[number];
export function isDropKind(value: unknown): value is DropKind {
  return typeof value === 'string' && DROP_KINDS.some((kind) => kind === value);
}
