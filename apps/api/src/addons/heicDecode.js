'use strict';

// HEIC / HEIF DECODING, for iPhone photos.
//
// The prebuilt sharp/libvips decodes HEIF containers holding AV1 (AVIF) but not
// HEVC, which is what an iPhone writes, and a custom libvips build is not
// something the API image should depend on. So HEIC goes through libheif-js:
// libheif (with its libde265 HEVC decoder) compiled to WebAssembly, no system
// packages, the same on macOS and in the node:20-slim image.
//
//   libheif-js  LGPL-3.0  (libheif LGPL-3.0, libde265 LGPL-3.0)
//
// Shipped unmodified as an npm dependency of this AGPL-3.0 server, which LGPL
// permits; anyone can swap in their own build of it.
//
// LAZY: the module (and its ~2MB WebAssembly) is loaded the first time a HEIC
// arrives, never at boot, so it costs nothing on a server that never sees one.
//
// BOUNDED: the image dimensions are read from the file's own header (ispe)
// BEFORE any pixel is decoded, and a file larger than MAX_PIXELS is refused
// there. Only the PRIMARY image is decoded; thumbnails, depth maps and the
// other frames of a multi-image file are never touched. The decoded RGBA has
// libheif's transforms (rotation `irot`, mirror `imir`, crop `clap`) already
// applied, and carries no metadata at all, so EXIF and GPS cannot survive it.

const { AddonError } = require('./errors');

let libheif = null;
function load() {
  if (!libheif) libheif = require('libheif-js/wasm-bundle');
  return libheif;
}

const HEIC_UNREADABLE = 'This HEIC photo could not be read: the file looks damaged or incomplete. Upload it again, or export it as JPEG.';

function unreadable(detail) {
  return new AddonError(415, 'addon_heic_unreadable', detail ? `${HEIC_UNREADABLE} (${detail})` : HEIC_UNREADABLE);
}

// libheif-js reports parse failures with console.log and an empty result;
// silence it for the one synchronous call so a bad upload is not log noise.
function quietly(fn) {
  const original = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = original;
  }
}

function displayRgba(image, width, height) {
  return new Promise((resolve, reject) => {
    const target = { data: new Uint8ClampedArray(width * height * 4), width, height };
    const original = console.log;
    console.log = () => {};
    try {
      image.display(target, (out) => {
        console.log = original;
        if (!out) reject(unreadable('the image data could not be decoded'));
        else resolve(out);
      });
    } catch (err) {
      console.log = original;
      reject(unreadable(err.message));
    }
  });
}

/**
 * Decode the primary image of a HEIC/HEIF buffer to raw RGBA.
 * @returns {Promise<{data: Buffer, width: number, height: number}>}
 */
async function decodeHeic(buffer, { maxPixels }) {
  let lib;
  try {
    lib = load();
  } catch (err) {
    throw new AddonError(503, 'addon_heic_unavailable', `HEIC decoding is not available on this server: ${err.message}`);
  }
  const decoder = new lib.HeifDecoder();
  try {
    let images;
    try {
      images = quietly(() => decoder.decode(buffer));
    } catch (err) {
      throw unreadable(err.message);
    }
    if (!Array.isArray(images) || !images.length) throw unreadable('no image found in the file');
    const primary = images.find((image) => {
      try { return image.is_primary(); } catch (_) { return false; }
    }) || images[0];
    const width = Number(primary.get_width());
    const height = Number(primary.get_height());
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw unreadable('it has no valid dimensions');
    }
    if (width * height > maxPixels) {
      throw new AddonError(413, 'addon_image_too_large', `This photo is ${width}x${height}, more than the ${Math.round(maxPixels / 1e6)} megapixels a photo may have.`);
    }
    const out = await displayRgba(primary, width, height);
    return { data: Buffer.from(out.data.buffer, out.data.byteOffset, out.data.byteLength), width: out.width, height: out.height };
  } finally {
    // Free the libheif context (and with it every image handle) now, rather
    // than holding the file in WebAssembly memory until the next decode.
    try {
      if (decoder.decoder) lib.heif_context_free(decoder.decoder);
      decoder.decoder = null;
    } catch (_) { /* best effort */ }
  }
}

module.exports = { decodeHeic };
