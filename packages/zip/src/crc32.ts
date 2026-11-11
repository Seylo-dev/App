// CRC-32 (IEEE 802.3, the zip one) without node:zlib, so the reader runs in
// browsers. The writer uses node:zlib's crc32, which gives the same values.

const table = (() => {
  const out = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    out[n] = c >>> 0;
  }
  return out;
})();

/** Continues `value` (0 to start) over `bytes`. */
export function crc32(bytes: Uint8Array, value = 0): number {
  let c = (value ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = (table[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
