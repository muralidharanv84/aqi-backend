-- Existing cached tokens are refreshed (or replaced by a full login) on the next run.
ALTER TABLE winix_auth_state ADD COLUMN id_token TEXT;
