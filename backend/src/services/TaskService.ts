import { v4 as uuidv4 } from 'uuid';
import { Bindings } from '../types/env';
import { Task, TaskStatus, TaskPhase } from '../types';

interface CreateTaskOptions {
  title?: string;
  videoPath: string;
  fps?: number;
  prompt?: string;
  outputFps?: number;
  priority?: number;
  tags?: string;
}

interface ListTasksOptions {
  status?: string;
  page?: number;
  limit?: number;
}

type D1ResultType = {
  success: boolean;
  meta?: {
    changes?: number;
  };
};

const phaseStatusMap: Record<TaskPhase, { running: TaskStatus; done: TaskStatus }> = {
  DETECT: { running: 'DETECTING', done: 'DETECTED' },
  ANALYZE: { running: 'ANALYZING', done: 'ANALYZED' },
  SELECT_FACES: { running: 'SELECTING_FACES', done: 'FACES_SELECTED' },
  GENERATE_CHARACTERS: { running: 'GENERATING_CHARACTERS', done: 'CHARACTERS_GENERATED' },
  CROP_SHOTS: { running: 'CROPPING_SHOTS', done: 'SHOTS_CROPPED' },
  CONVERT_FRAMES: { running: 'CONVERTING_FRAMES', done: 'FRAMES_CONVERTED' },
  GENERATE_SHOTS: { running: 'GENERATING_SHOTS', done: 'SHOTS_GENERATED' },
  COMPOSE: { running: 'COMPOSING', done: 'COMPLETED' },
};

const phaseOrder: TaskPhase[] = [
  'DETECT', 'ANALYZE', 'SELECT_FACES', 'GENERATE_CHARACTERS',
  'CROP_SHOTS', 'CONVERT_FRAMES', 'GENERATE_SHOTS', 'COMPOSE'
];

const phasesRequiringAI: Record<TaskPhase, string> = {
  ANALYZE: 'text',
  GENERATE_CHARACTERS: 'image',
  CONVERT_FRAMES: 'image',
  GENERATE_SHOTS: 'video',
  DETECT: '',
  SELECT_FACES: '',
  CROP_SHOTS: '',
  COMPOSE: '',
};

export class TaskService {
  constructor(private env: Bindings) {}

  async createTask(options: CreateTaskOptions): Promise<Task> {
    const taskId = uuidv4();
    
    const result = await this.env.DB.prepare(`
      INSERT INTO tasks (
        id, user_id, title, status, video_path, fps, prompt, output_fps, 
        priority, tags, max_retries, expires_at, current_phase
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      taskId,
      'default_user',
      options.title || `Task ${taskId.slice(0, 8)}`,
      'PENDING',
      options.videoPath,
      options.fps || 30,
      options.prompt || '',
      options.outputFps || 24,
      options.priority || 0,
      options.tags || '',
      3,
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      'DETECT'
    ).run() as D1ResultType;

    if (!result.success || (result.meta?.changes ?? 0) === 0) {
      throw new Error('Failed to create task');
    }

    const task = await this.getTask(taskId);
    if (!task) throw new Error('Failed to retrieve created task');
    return task;
  }

  async getTask(taskId: string): Promise<Task | null> {
    const result = await this.env.DB.prepare(`
      SELECT * FROM tasks WHERE id = ?
    `).bind(taskId).first();

    if (!result) return null;
    return result as unknown as Task;
  }

  async listTasks(options: ListTasksOptions = {}): Promise<Task[]> {
    const { status, page = 1, limit = 20 } = options;
    
    let query = 'SELECT * FROM tasks';
    const params: (string | number)[] = [];
    
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, (page - 1) * limit);

    const result = await this.env.DB.prepare(query).bind(...params).all();
    
    return result.results as unknown as Task[];
  }

  async updateTask(taskId: string, updates: Partial<Task>): Promise<Task | null> {
    const task = await this.getTask(taskId);
    if (!task) return null;

    const updateFields: string[] = [];
    const params: (string | number)[] = [];

    if (updates.title !== undefined) {
      updateFields.push('title = ?');
      params.push(updates.title);
    }
    if (updates.status !== undefined) {
      updateFields.push('status = ?');
      params.push(updates.status);
    }
    if (updates.prompt !== undefined) {
      updateFields.push('prompt = ?');
      params.push(updates.prompt);
    }
    if (updates.fps !== undefined) {
      updateFields.push('fps = ?');
      params.push(updates.fps);
    }
    if (updates.output_fps !== undefined) {
      updateFields.push('output_fps = ?');
      params.push(updates.output_fps);
    }
    if (updates.priority !== undefined) {
      updateFields.push('priority = ?');
      params.push(updates.priority);
    }
    if (updates.tags !== undefined) {
      updateFields.push('tags = ?');
      params.push(updates.tags);
    }
    if (updates.current_phase !== undefined) {
      updateFields.push('current_phase = ?');
      params.push(updates.current_phase);
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(taskId);

    if (updateFields.length === 1) {
      return task;
    }

    await this.env.DB.prepare(`
      UPDATE tasks SET ${updateFields.join(', ')} WHERE id = ?
    `).bind(...params).run();

    return await this.getTask(taskId);
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const result = await this.env.DB.prepare(`
      DELETE FROM tasks WHERE id = ?
    `).bind(taskId).run() as D1ResultType;

    return result.success && (result.meta?.changes ?? 0) > 0;
  }

  async startTask(taskId: string): Promise<Task | null> {
    const task = await this.getTask(taskId);
    if (!task) return null;

    if (task.status !== 'PENDING') {
      throw new Error(`Task is not in PENDING state: ${task.status}`);
    }

    const currentPhase = (task.current_phase as TaskPhase) || 'DETECT';
    return await this.startPhase(taskId, currentPhase);
  }

  async startPhase(taskId: string, phase: TaskPhase): Promise<Task | null> {
    const task = await this.getTask(taskId);
    if (!task) return null;

    const accountService = await import('./AccountService');
    const ghAccount = await new accountService.AccountService(this.env).selectAvailableGitHubAccount();
    
    if (!ghAccount) {
      throw new Error('No available GitHub account');
    }

    let aiAccount: any = null;
    const requiredApiType = phasesRequiringAI[phase];
    if (requiredApiType) {
      aiAccount = await new accountService.AccountService(this.env).selectAIAccount(requiredApiType);
      if (!aiAccount) {
        throw new Error(`No available ${requiredApiType} AI account`);
      }
    }

    const status = phaseStatusMap[phase].running;
    
    await this.env.DB.prepare(`
      UPDATE tasks SET status = ?, current_phase = ?, started_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'), github_account_id = ?
      WHERE id = ?
    `).bind(status, phase, ghAccount ? ghAccount.id : null, taskId).run();

    if (aiAccount) {
      await this.env.DB.prepare(`
        UPDATE tasks SET ai_account_id = ? WHERE id = ?
      `).bind(aiAccount ? aiAccount.id : null, taskId).run();
    }

    try {
      await this.triggerPhase(taskId, phase);
    } catch (error) {
      await this.env.DB.prepare(`
        UPDATE tasks SET status = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).bind('PENDING', taskId).run();
      throw error;
    }

    return await this.getTask(taskId);
  }

  async cancelTask(taskId: string): Promise<Task | null> {
    const task = await this.getTask(taskId);
    if (!task) return null;

    await this.env.DB.prepare(`
      UPDATE tasks SET status = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind('CANCELLED', taskId).run();

    return await this.getTask(taskId);
  }

  async retryFailedTask(taskId: string): Promise<Task | null> {
    const task = await this.getTask(taskId);
    if (!task) return null;

    if (task.status !== 'FAILED') {
      throw new Error(`Task is not in FAILED state: ${task.status}`);
    }

    if (task.retry_count >= task.max_retries) {
      throw new Error('Max retry count reached');
    }

    await this.env.DB.prepare(`
      UPDATE tasks SET status = ?, retry_count = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind('PENDING', task.retry_count + 1, taskId).run();

    return await this.getTask(taskId);
  }

  async triggerPhase(taskId: string, phase: TaskPhase) {
    console.log('triggerPhase called:', { taskId, phase });
    
    const task = await this.getTask(taskId);
    if (!task) {
      console.error('triggerPhase: Task not found, taskId:', taskId);
      throw new Error('Task not found');
    }

    const accountService = await import('./AccountService');
    let ghAccount: any = null;
    let aiAccount: any = null;

    ghAccount = await new accountService.AccountService(this.env).selectAvailableGitHubAccount();
    
    const requiredApiType = phasesRequiringAI[phase];
    if (requiredApiType) {
      aiAccount = await new accountService.AccountService(this.env).selectAIAccount(requiredApiType);
    }

    await this.env.DB.prepare(`
      UPDATE tasks SET current_phase = ?, status = ?, github_account_id = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind(phase, phaseStatusMap[phase].running, ghAccount ? ghAccount.id : null, taskId).run();

    if (aiAccount) {
      await this.env.DB.prepare(`
        UPDATE tasks SET ai_account_id = ? WHERE id = ?
      `).bind(aiAccount ? aiAccount.id : null, taskId).run();
    }

    if (!ghAccount) {
      console.error('triggerPhase: No available GitHub account');
      throw new Error('No available GitHub account');
    }
    if (!aiAccount && phasesRequiringAI[phase]) {
      console.error('triggerPhase: No available AI account for phase:', phase);
      throw new Error('No available AI account');
    }

    await this.dispatchGitHubWorkflow(taskId, phase, ghAccount?.id, aiAccount?.id);

    await this.logTask(taskId, phase, 'INFO', `Phase ${phase} triggered`);
    console.log('triggerPhase completed successfully:', { taskId, phase });
  }

  async dispatchGitHubWorkflow(taskId: string, phase: TaskPhase, ghAccountId?: number, aiAccountId?: number) {
    console.log('dispatchGitHubWorkflow called:', { taskId, phase, ghAccountId, aiAccountId });
    
    const owner = this.env.GITHUB_REPO_OWNER;
    const repo = this.env.GITHUB_REPO_NAME;
    
    console.log('dispatchGitHubWorkflow: GitHub config:', { owner, repo });
    
    if (!owner || !repo) {
      console.error('dispatchGitHubWorkflow: GitHub repository not configured');
      throw new Error('GitHub repository not configured');
    }

    let ghApiKey = '';
    if (ghAccountId) {
      console.log('dispatchGitHubWorkflow: Fetching GitHub account, id:', ghAccountId);
      const accountResult = await this.env.DB.prepare(`
        SELECT token_encrypted FROM github_accounts WHERE id = ?
      `).bind(ghAccountId).first();

      if (!accountResult) {
        console.error('dispatchGitHubWorkflow: GitHub account not found, id:', ghAccountId);
        throw new Error('GitHub account not found');
      }

      ghApiKey = (accountResult as { token_encrypted: string }).token_encrypted;
      
      console.log('dispatchGitHubWorkflow: ghApiKey length:', ghApiKey.length);
      
      if (!ghApiKey) {
        console.error('dispatchGitHubWorkflow: GitHub account token is empty');
        throw new Error('GitHub account token is empty');
      }
    } else {
      console.error('dispatchGitHubWorkflow: ghAccountId is undefined');
      throw new Error('GitHub account ID is undefined');
    }

    const task = await this.getTask(taskId);
    if (!task) {
      console.error('dispatchGitHubWorkflow: Task not found, taskId:', taskId);
      throw new Error('Task not found');
    }

    const payload = {
      event_type: `video-processing-${phase.toLowerCase()}`,
      client_payload: {
        task_id: taskId,
        phase: phase,
        gh_account_id: ghAccountId,
        ai_account_id: aiAccountId,
        video_path: task.video_path,
        fps: task.fps,
        prompt: task.prompt,
        output_fps: task.output_fps,
      },
    };

    console.log('dispatchGitHubWorkflow: Sending request to:', `https://api.github.com/repos/${owner}/${repo}/dispatches`);
    
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `token ${ghApiKey}`,
          'User-Agent': 'AI-Video-Processor',
        },
        body: JSON.stringify(payload),
      }
    );

    console.log('dispatchGitHubWorkflow: Response status:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('dispatchGitHubWorkflow: GitHub API error:', { status: response.status, errorText });
      throw new Error(`Failed to dispatch workflow: ${response.status} ${errorText}`);
    }

    console.log('dispatchGitHubWorkflow: GitHub workflow dispatched successfully for task', taskId);
  }

  async handleGitHubCallback(body: any) {
    const { task_id: taskId, phase, status, run_id: runId } = body;
    
    console.log('handleGitHubCallback called:', { taskId, phase, status, runId });
    
    await this.env.DB.prepare(`
      UPDATE tasks SET current_run_id = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind(runId, taskId).run();

    if (status === 'success') {
      try {
        await this.advancePhase(taskId);
        console.log('advancePhase completed successfully for task:', taskId);
      } catch (error) {
        console.error('Error in advancePhase:', error);
        await this.logTask(taskId, phase, 'ERROR', `Failed to advance phase: ${(error as Error).message}`);
        throw error;
      }
    } else if (status === 'failure') {
      await this.handleTaskError({ taskId, error: body.error || 'Workflow failed' });
    }

    return { success: true };
  }

  async updateTaskProgress(body: any) {
    const { task_id: taskId, processed_count: processedCount, total_count: totalCount } = body;
    
    await this.env.DB.prepare(`
      UPDATE tasks SET processed_frames = ?, total_frames = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind(processedCount, totalCount, taskId).run();

    return { success: true };
  }

  async handleTaskComplete(body: any) {
    const { task_id: taskId, final_video_url: finalVideoUrl } = body;
    
    await this.env.DB.prepare(`
      UPDATE tasks SET status = ?, final_video_url = ?, completed_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind('COMPLETED', finalVideoUrl, taskId).run();

    await this.logTask(taskId, 'COMPLETE', 'INFO', 'Task completed successfully');

    return { success: true };
  }

  async handleTaskError(body: any) {
    const { taskId, error } = body;
    
    const task = await this.getTask(taskId);
    if (!task) return { success: false };

    if (task.retry_count >= task.max_retries) {
      await this.env.DB.prepare(`
        UPDATE tasks SET status = ?, error_msg = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).bind('FAILED', error, taskId).run();

      await this.logTask(taskId, 'ERROR', 'ERROR', `Task failed: ${error}`);
    } else {
      await this.env.DB.prepare(`
        UPDATE tasks SET status = ?, retry_count = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).bind('PENDING', task.retry_count + 1, taskId).run();

      await this.logTask(taskId, 'ERROR', 'WARNING', `Task failed, retrying: ${error}`);
    }

    return { success: true };
  }

  async advancePhase(taskId: string) {
    const task = await this.getTask(taskId);
    if (!task) {
      console.log('advancePhase: Task not found, taskId:', taskId);
      return;
    }

    console.log('advancePhase: Current task state:', { taskId, currentPhase: task.current_phase, status: task.status });

    const currentPhase = task.current_phase as TaskPhase || 'DETECT';
    const currentIndex = phaseOrder.indexOf(currentPhase);
    const nextPhase = phaseOrder[currentIndex + 1];

    console.log('advancePhase: Phase transition:', { currentPhase, nextPhase });

    if (!nextPhase) {
      console.log('advancePhase: No next phase found for:', currentPhase);
      if (currentPhase === 'COMPOSE') {
        await this.env.DB.prepare(`
          UPDATE tasks SET status = ?, completed_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?
        `).bind('COMPLETED', taskId).run();
        console.log('advancePhase: Task marked as completed:', taskId);
      }
      return;
    }

    const doneStatus = phaseStatusMap[currentPhase].done;
    
    await this.env.DB.prepare(`
      UPDATE tasks SET status = ?, current_phase = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind(doneStatus, nextPhase, taskId).run();
    console.log('advancePhase: Task status updated to:', { status: doneStatus, currentPhase: nextPhase });

    await this.triggerPhase(taskId, nextPhase);
  }

  async logTask(taskId: string, phase: string, level: string, message: string) {
    await this.env.DB.prepare(`
      INSERT INTO operation_logs (task_id, phase, level, message)
      VALUES (?, ?, ?, ?)
    `).bind(taskId, phase, level, message).run();
  }

  async getTaskLogs(taskId: string) {
    const result = await this.env.DB.prepare(`
      SELECT * FROM operation_logs WHERE task_id = ? ORDER BY created_at DESC
    `).bind(taskId).all();

    return result.results;
  }

  async batchCreateTasks(tasks: CreateTaskOptions[]): Promise<Task[]> {
    const results: Task[] = [];
    
    for (const taskOptions of tasks) {
      const task = await this.createTask(taskOptions);
      results.push(task);
    }

    return results;
  }

  getNextPhase(phase: TaskPhase): TaskPhase | null {
    const index = phaseOrder.indexOf(phase);
    return phaseOrder[index + 1] || null;
  }

  getPhaseOrder(): TaskPhase[] {
    return [...phaseOrder];
  }
}