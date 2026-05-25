ALTER TABLE load_jobs ADD COLUMN source_type TEXT NOT NULL DEFAULT 'http';
ALTER TABLE load_jobs ADD COLUMN source_config TEXT;
