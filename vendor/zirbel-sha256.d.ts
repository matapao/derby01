/** Public @zirbel/core/sha256 export contract; source and licence retained beside the bundle. */
export function sha256(data: Uint8Array): Uint8Array<ArrayBuffer>;
export function jsSha256(data: Uint8Array): Uint8Array<ArrayBuffer>;
export function useSha256(implementation: (data: Uint8Array) => Uint8Array<ArrayBuffer>): void;
