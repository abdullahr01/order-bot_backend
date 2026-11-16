// Dish photos in the Supabase Storage bucket `menus`, one folder per restaurant.
// Anyone can view them; only this server (the secret key) can add or remove them.
export const PHOTO_BUCKET = 'menus';

/** The start of every photo URL this API issues for one restaurant. */
export const photoUrlPrefix = (supabaseUrl, tenantId) => `${supabaseUrl}/storage/v1/object/public/${PHOTO_BUCKET}/${tenantId}/`;

const PAGE = 1000;

export class PhotoStorageError extends Error {
  constructor(cause, action = 'upload') {
    super(`Supabase Storage ${action} failed`);
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
    return this.#url(path);
  }

  #url(path) { return `${this.#supabaseUrl}/storage/v1/object/public/${PHOTO_BUCKET}/${path}`; }

  async #list(prefix) {
    const entries = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await this.#bucket.list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw new PhotoStorageError(error, 'list');
      entries.push(...data);
      if (data.length < PAGE) return entries;
    }
  }

  /** The restaurant folders in the bucket (folders have no id). */
  async folders() {
    return (await this.#list('')).filter((entry) => entry.id === null).map((entry) => entry.name);
  }

  /** One restaurant's photos: path, public URL and when it was uploaded. */
  async files(folder) {
    return (await this.#list(folder)).filter((entry) => entry.id !== null).map((entry) => ({
      path: `${folder}/${entry.name}`, url: this.#url(`${folder}/${entry.name}`), createdAt: new Date(entry.created_at),
    }));
  }

  async remove(paths) {
    const { error } = await this.#bucket.remove(paths);
    if (error) throw new PhotoStorageError(error, 'remove');
  }
}
