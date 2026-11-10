import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { MenuModel } from '../model/menu.model.js';
import { MENU_PHOTO_MAX_BYTES, MENU_PHOTO_MAX_PX, MENU_PHOTO_TYPES } from '../shared/rules/menu.js';
import { apiError } from '../shared/error-codes.js';

const INVALID = () => apiError('invalid_photo', 'Use a JPG, PNG or WebP photo.');
const TOO_LARGE = () => apiError('photo_too_large', 'That photo is too large. Try a smaller one.');
const FORMATS = new Set(['jpeg', 'png', 'webp']);
// A 640 px photo has well under a million pixels; this stops a "decompression bomb".
const MAX_INPUT_PIXELS = 40_000_000;

/**
 * Re-creates the photo as a fresh JPEG: never the upload as given (guide 8.6). This
 * drops anything hidden in the file and the phone's location data.
 */
export async function cleanPhoto(buffer) {
  let image;
  try {
    image = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
    const { format } = await image.metadata();
    if (!FORMATS.has(format)) throw INVALID();
  } catch (error) {
    if (error?.code === 'invalid_photo') throw error;
    throw INVALID();
  }
  try {
    return await image
      .rotate()
      .resize(MENU_PHOTO_MAX_PX, MENU_PHOTO_MAX_PX, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
  } catch {
    throw INVALID();
  }
}

export class PhotoService {
  #storage;

  constructor({ storage }) { this.#storage = storage; }

  async upload({ actor, log }, body) {
    const match = MenuModel.PHOTO_DATA_URL.exec(typeof body?.dataUrl === 'string' ? body.dataUrl : '');
    if (!match || !MENU_PHOTO_TYPES.includes(match[1])) throw INVALID();
    // Base64 is four characters for every three bytes: refuse before decoding a huge file.
    if (match[2].length * 0.75 > MENU_PHOTO_MAX_BYTES + 3) throw TOO_LARGE();
    const original = Buffer.from(match[2], 'base64');
    if (original.length > MENU_PHOTO_MAX_BYTES) throw TOO_LARGE();

    const cleaned = await cleanPhoto(original);
    const path = `${actor.tenantId}/${randomUUID()}.jpg`;
    log.info({ tenantId: actor.tenantId, uploadedBytes: original.length, storedBytes: cleaned.length }, 'Storing dish photo');
    const url = await this.#storage.upload(path, cleaned);
    log.success({ tenantId: actor.tenantId }, 'Dish photo stored');
    return { url };
  }
}
