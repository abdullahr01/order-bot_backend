// Dish photos in the Supabase Storage bucket `menus`, one folder per restaurant.
// Anyone can view them; only this server (the secret key) can add or remove them.
export const PHOTO_BUCKET = 'menus';

/** The start of every photo URL this API issues for one restaurant. */
export const photoUrlPrefix = (supabaseUrl, tenantId) => `${supabaseUrl}/storage/v1/object/public/${PHOTO_BUCKET}/${tenantId}/`;

export class PhotoStorageError extends Error {
  constructor(cause) {
    super('Supabase Storage upload failed');
    this.name = 'PhotoStorageError';
    this.status = Number.isInteger(Number(cause?.statusCode)) ? Number(cause.statusCode) : null;
  }
}

export class SupabasePhotoStorage {
  #bucket;
  #supabaseUrl;

  constructor(client, supabaseUrl) {
    this.#bucket = client.storage.from(PHOTO_BUCKET);
    this.#supabaseUrl = supabaseUrl;
  }

  /** `path` is `<tenant id>/<random>.jpg`. Returns the public URL. */
  async upload(path, buffer) {
    const { error } = await this.#bucket.upload(path, buffer, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false });
    if (error) throw new PhotoStorageError(error);
    return `${this.#supabaseUrl}/storage/v1/object/public/${PHOTO_BUCKET}/${path}`;
  }
}
