-- Add scheduled_at column to tasks table for scheduled (delayed) task start
ALTER TABLE tasks ADD COLUMN scheduled_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_at ON tasks(scheduled_at);
