CREATE TABLE IF NOT EXISTS github_ai_bindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    github_account_id INTEGER NOT NULL,
    ai_account_id INTEGER NOT NULL,
    priority INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(github_account_id, ai_account_id),
    FOREIGN KEY (github_account_id) REFERENCES github_accounts(id),
    FOREIGN KEY (ai_account_id) REFERENCES ai_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_bindings_github ON github_ai_bindings(github_account_id);
CREATE INDEX IF NOT EXISTS idx_bindings_ai ON github_ai_bindings(ai_account_id);

ALTER TABLE ai_accounts ADD COLUMN api_type TEXT DEFAULT 'image';