CREATE INDEX IF NOT EXISTS idx_phase_subtasks_task_phase_index ON phase_subtasks(task_id, phase, subtask_index, id);

CREATE INDEX IF NOT EXISTS idx_ai_accounts_active_healthy_type ON ai_accounts(is_active, is_healthy, api_type);
