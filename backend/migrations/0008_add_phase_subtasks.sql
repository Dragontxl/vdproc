CREATE TABLE IF NOT EXISTS phase_subtasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    subtask_index INTEGER NOT NULL,
    subtask_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    input_path TEXT,
    output_path TEXT,
    ai_account_id INTEGER,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    error_msg TEXT,
    metadata TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id),
    FOREIGN KEY (ai_account_id) REFERENCES ai_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_phase_subtasks_task ON phase_subtasks(task_id);
CREATE INDEX IF NOT EXISTS idx_phase_subtasks_phase ON phase_subtasks(phase);
CREATE INDEX IF NOT EXISTS idx_phase_subtasks_status ON phase_subtasks(status);
CREATE INDEX IF NOT EXISTS idx_phase_subtasks_type ON phase_subtasks(subtask_type);