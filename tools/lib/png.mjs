/**
 * Minimal PNG encoder.
 *
 * ## Why this exists
 *
 * V7 needs real texture files rather than solid prototype colours. Sourcing textures from the internet
 * introduces exactly the licensing ambiguity the brief forbids, so they are **generated in-project** and
 * written to disk as ordinary PNG files, which the client then loads through Babylon's normal texture
 * pipeline like any other asset.
 *
 * The point is that the texture is a *file on disk* with a recorded provenance, not a value computed at
 * runtime: it is inspectable, cacheable, swappable, and replaceable by an artist's PNG later without
 * touching code. That is what makes it an asset rather than more procedural drawing.
 *
 * PNG is chosen because it is lossless, universally decodable, and — for our purposes — trivially
 * encodable: zlib is in Node's standard library and PNG's container is a header plus a deflate stream.
 *
 * Only the 8-bit RGB/RGBA, non-interlaced subset is implemented, because that is all this project emits.
 */

import { deflateSync } from 'node:zlib';

/** CRC-32 table, built once. PNG requires a CRC over each chunk's type and data. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, payload, CRC over type+payload. */
function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Encodes an image as a PNG buffer.
 *
 * @param {number} width image width in pixels
 * @param {number} height image height in pixels
 * @param {Uint8Array} pixels `width * height * channels` bytes, row-major from the top-left
 * @param {number} channels 3 for RGB, 4 for RGBA
 * @returns {Buffer} the complete PNG file
 */
export function encodePng(width, height, pixels, channels = 3) {
  if (pixels.length !== width * height * channels) {
    throw new Error(`encodePng: expected ${width * height * channels} bytes, got ${pixels.length}`);
  }
  if (channels !== 3 && channels !== 4) {
    throw new Error(`encodePng: only 3 or 4 channels are supported, got ${channels}`);
  }

  // Raw scanlines, each prefixed with filter type 0 (None). Filtering would compress better, but these
  // textures are small and this keeps the encoder readable enough to be obviously correct.
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // colour type: RGBA or RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
