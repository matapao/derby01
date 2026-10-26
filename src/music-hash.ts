import { sha256 } from '../vendor/zirbel-sha256.js';
/** Web Crypto when available; the same reviewed portable owner also works on ordinary HTTP LAN pages. */
export async function hashMusic(
  bytes: ArrayBuffer,
  subtle: Pick<SubtleCrypto, 'digest'> | null | undefined = globalThis.crypto?.subtle,
): Promise<string> {
  const digest = subtle
    ? new Uint8Array(await subtle.digest('SHA-256', bytes))
    : sha256(new Uint8Array(bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
