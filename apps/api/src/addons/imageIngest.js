'use strict';

// IMAGES ON THE WAY IN.
//
// The real type is SNIFFED FROM THE BYTES. The filename and the client's mime
// are never consulted: a renamed text file is refused however it is labelled.
//
// Every stored variant is RE-ENCODED by sharp, which writes no metadata unless
// asked to, so EXIF (phone photos carry GPS) is gone from all three: the
// 256px thumb, the 1024px view, and the "original", which is the full-size
// image auto-oriented and re-encoded in its own format (HEIC/HEIF as JPEG, so
// nothing downstream needs a HEIC decoder; see heicDecode.js). Orientation is applied before the metadata
// goes, so a portrait photo stays portrait.

const crypto = require('crypto');
const sharp = require('sharp');
const { AddonError } = require('./errors');

const MAX_INPUT_PIXELS = 80 * 1000 * 1000; // ~80MP: refuses decompression bombs
// HEIF major brands. `avif` is deliberately absent: AVIF is not on the list of
// accepted types, and sharp would decode it directly anyway.
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'heif', 'mif1', 'msf1']);

/** 'jpeg' | 'png' | 'webp' | 'heif' | null, from magic bytes only. */
function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    const major = buffer.toString('ascii', 8, 12);
    if (HEIF_BRANDS.has(major)) return 'heif';
  }
  return null;
}

const OUTPUT = {
  jpeg: { mime: 'image/jpeg', encode: (img) => img.jpeg({ quality: 90, mozjpeg: true }) },
  png: { mime: 'image/png', encode: (img) => img.png({ compressionLevel: 9 }) },
  webp: { mime: 'image/webp', encode: (img) => img.webp({ quality: 90 }) },
  // Stored as JPEG, so nothing downstream ever needs a HEIC decoder. Flattened
  // first: JPEG has no alpha channel.
  heif: { mime: 'image/jpeg', encode: (img) => img.flatten({ background: '#ffffff' }).jpeg({ quality: 90, mozjpeg: true }) },
};

/**
 * @returns {Promise<{sha256, mime, width, height, variants: {thumb: Buffer, view: Buffer, original: Buffer}}>}
 */
async function processImage(buffer) {
  const type = sniffImageType(buffer);
  if (!type) {
    throw new AddonError(415, 'addon_unsupported_type', 'Only JPEG, PNG, WebP and HEIC/HEIF images can be uploaded. The file contents are not one of those, whatever its name says.');
  }
  let oriented;
  if (type === 'heif') {
    // iPhone photos: decoded by libheif (WebAssembly), loaded only now. The
    // primary image comes back as raw RGBA with rotation already applied and
    // no metadata at all; from here it is treated like any other image.
    const { decodeHeic } = require('./heicDecode');
    const raw = await decodeHeic(buffer, { maxPixels: MAX_INPUT_PIXELS });
    oriented = await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 }, limitInputPixels: MAX_INPUT_PIXELS })
      .png({ compressionLevel: 1 })
      .toBuffer({ resolveWithObject: true });
  } else {
    try {
      oriented = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).rotate().toBuffer({ resolveWithObject: true });
    } catch (err) {
      throw new AddonError(415, 'addon_unreadable_image', `The image could not be read: ${err.message}`);
    }
  }
  const { width, height } = oriented.info;
  const fromOriented = () => sharp(oriented.data, { limitInputPixels: MAX_INPUT_PIXELS });
  const [original, view, thumb] = await Promise.all([
    OUTPUT[type].encode(fromOriented()).toBuffer(),
    fromOriented().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(),
    fromOriented().resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer(),
  ]);
  return {
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    mime: OUTPUT[type].mime,
    width,
    height,
    variants: { thumb, view, original },
  };
}

module.exports = { processImage, sniffImageType };
