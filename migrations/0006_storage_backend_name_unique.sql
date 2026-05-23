-- Migration number: 0006
-- Names must be unique per user so r2://name/key URIs can resolve unambiguously.
CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_backends_user_name ON storage_backends(user_id, name);
