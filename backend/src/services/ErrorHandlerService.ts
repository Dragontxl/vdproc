import { Bindings } from '../types/env';

interface TaskRow {
  id: string;
  retry_count: number;
  max_retries: number;
}

type D1ResultType = {
  success: boolean;
  meta?: {
    changes?: number;
  };
};

export class ErrorHandlerService {
  constructor(private env: Bindings) {}

  async handleTaskError(taskId: string, error: any, phase: string) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : '';

    await this.env.DB.prepare(`
      UPDATE tasks 
      SET error_msg = ?, error_stack = ?, status = 'FAILED', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(errorMsg, errorStack, taskId).run();

    await this.env.DB.prepare(`
      INSERT INTO operation_logs (task_id, phase, level, message)
      VALUES (?, ?, 'ERROR', ?)
    `).bind(taskId, phase, errorMsg).run();

    const task = await this.env.DB.prepare(`
      SELECT * FROM tasks WHERE id = ?
    `).bind(taskId).first() as TaskRow | null;

    if (task && task.retry_count < task.max_retries) {
      await this.env.DB.prepare(`
        UPDATE tasks 
        SET status = 'PENDING', retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(taskId).run();

      await this.env.DB.prepare(`
        INSERT INTO operation_logs (task_id, phase, level, message)
        VALUES (?, ?, 'WARNING', ?)
      `).bind(taskId, phase, `Retrying task (attempt ${task.retry_count + 1}/${task.max_retries})`).run();
    }

    return { success: true, retryAttempt: task?.retry_count || 0 };
  }

  async handleGitHubError(taskId: string, error: any) {
    return await this.handleTaskError(taskId, error, 'GITHUB');
  }

  async handleAIError(taskId: string, error: any) {
    return await this.handleTaskError(taskId, error, 'AI');
  }

  async logError(taskId: string, phase: string, message: string, metadata?: any) {
    await this.env.DB.prepare(`
      INSERT INTO operation_logs (task_id, phase, level, message, metadata)
      VALUES (?, ?, 'ERROR', ?, ?)
    `).bind(taskId, phase, message, metadata ? JSON.stringify(metadata) : null).run();
  }

  async logWarning(taskId: string, phase: string, message: string, metadata?: any) {
    await this.env.DB.prepare(`
      INSERT INTO operation_logs (task_id, phase, level, message, metadata)
      VALUES (?, ?, 'WARNING', ?, ?)
    `).bind(taskId, phase, message, metadata ? JSON.stringify(metadata) : null).run();
  }

  async logInfo(taskId: string, phase: string, message: string, metadata?: any) {
    await this.env.DB.prepare(`
      INSERT INTO operation_logs (task_id, phase, level, message, metadata)
      VALUES (?, ?, 'INFO', ?, ?)
    `).bind(taskId, phase, message, metadata ? JSON.stringify(metadata) : null).run();
  }

  async getTaskErrors(taskId: string) {
    const result = await this.env.DB.prepare(`
      SELECT * FROM operation_logs 
      WHERE task_id = ? AND level = 'ERROR' 
      ORDER BY created_at DESC
    `).bind(taskId).all();

    return result.results;
  }

  async cleanupOldLogs(daysToKeep: number = 30) {
    await this.env.DB.prepare(`
      DELETE FROM operation_logs 
      WHERE created_at < DATE('now', '-${daysToKeep} days')
    `).run();

    await this.env.DB.prepare(`
      DELETE FROM alert_history 
      WHERE triggered_at < DATE('now', '-${daysToKeep} days')
    `).run();

    return { success: true };
  }
}