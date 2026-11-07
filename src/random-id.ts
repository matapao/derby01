/**
 * A random v4 UUID. crypto.randomUUID exists only on secure pages, and a zirbel host on a home network
 * serves the game over plain http, so this builds one from getRandomValues, which works on both.
 */
export function randomId(source: Pick<Crypto, 'getRandomValues'> = crypto): string {
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => (b + 256).toString(16).slice(1)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
