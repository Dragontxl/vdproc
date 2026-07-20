CREATE TABLE IF NOT EXISTS uploads (
    upload_id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'uploading',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_uploads_status ON uploads(status);

CREATE TABLE IF NOT EXISTS upload_parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id TEXT NOT NULL,
    part_number INTEGER NOT NULL,
    etag TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (upload_id) REFERENCES uploads(upload_id)
);

CREATE INDEX IF NOT EXISTS idx_upload_parts_upload ON upload_parts(upload_id);