-- PT38 — a photo whose upload reached the server but whose reply was lost was
-- uploaded twice: PhotoUpload queues on any thrown fetch, including a connection
-- that dropped after the server had stored the photo, and the queue replayed it.
--
-- The client now sends `client_id` (the queue row's uuid, made before the first
-- attempt) with every upload. Unique, so a repeat is answered with the row that
-- already exists instead of a second row and a second stored file.
--
-- Additive and nullable: uploads from an older bundle carry no client_id and
-- behave exactly as before (a unique index allows any number of NULLs).
-- IF NOT EXISTS throughout, matching 001–003; apply-schema.mjs (PT30) records it.

ALTER TABLE photos ADD COLUMN IF NOT EXISTS client_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS photos_client_id_key ON photos (client_id);
