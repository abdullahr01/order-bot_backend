-- Dish photos (guide 8.6): Supabase Storage bucket `menus`, one folder per restaurant,
-- menus/<tenant_id>/<random>.jpg. Public, so diners' phones load photos straight from
-- the CDN without signing in. There are no storage policies, so with RLS on
-- storage.objects only this server (the secret key) can add or remove files.
-- The API re-encodes every photo as a 640 px JPEG, well under the 1 MB cap.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menus', 'menus', true, 1048576, array['image/jpeg'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
