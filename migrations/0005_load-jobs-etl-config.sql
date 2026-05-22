-- Migration number: 0005 	 2026-05-21T23:07:59.191Z
ALTER TABLE load_jobs ADD COLUMN date_range_config TEXT DEFAULT NULL;
ALTER TABLE load_jobs ADD COLUMN pagination_config TEXT DEFAULT NULL;
