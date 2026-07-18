import { Bindings } from '../types/env';
import { Task, TaskPhase, TaskStatus, Shot, Character, ShotDetail, CharacterFrame } from '../types';
import { CryptoService } from './CryptoService';
import { MaterialCheckService } from './MaterialCheckService';

const phaseOrder: TaskPhase[] = ['DETECT', 'ANALYZE', 'SELECT_FACES', 'GENERATE_CHARACTERS', 'CROP_SHOTS', 'CONVERT_FRAMES', 'GENERATE_SHOTS', 'COMPOSE'];

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

const phasesRequiringAI: Partial<Record<TaskPhase, string>> = {
  ANALYZE: 'text',
  GENERATE_CHARACTERS: 'image',
  CONVERT_FRAMES: 'image',
  GENERATE_SHOTS: 'video',
};

export class TaskService {
  private cryptoService: CryptoService;

  constructor(private env: Bindings) {
    this.cryptoService = new CryptoService(env);
  }

  async createTask(data: {
    title: string;
    videoPath: string;
    fps: number;
    prompt: string;
    outputFps: number;
    priority?: number;
    tags?: string;
  }): Promise<Task> {
    const task: Task = {
      id: this.generateUUID(),
      user_id: 'default_user',
      title: data.title,
      video_path: data.videoPath,
      fps: data.fps,
      prompt: data.prompt,
      output_fps: data.outputFps,
      priority: data.priority || 0,
      tags: data.tags || '',
      status: 'PENDING',
      current_phase: 'DETECT',
      progress: 0,
      total_frames: 0,
      processed_frames: 0,
      failed_frames: 0,
      retry_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await this.env.DB.prepare(`
      INSERT INTO tasks (id, user_id, title, status, current_phase, video_path, fps, prompt, output_fps, priority, tags, progress, total_frames, processed_frames, failed_frames, retry_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        task.id,
        task.user_id,
        task.title,
        task.status,
        task.current_phase,
        task.video_path,
        task.fps,
        task.prompt,
        task.output_fps,
        task.priority,
        task.tags,
        task.progress,
        task.total_frames,
        task.processed_frames,
        task.failed_frames || 0,
        task.retry_count,
        task.created_at,
        task.updated_at
      )
      .run();

    return task;
  }

  async getTask(id: string): Promise<Task | null> {
    const result = await this.env.DB.prepare(
      `SELECT * FROM tasks WHERE id = ?`
    ).bind(id).first();
    return result as Task | null;
  }

  async listTasks(filters: {
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<Task[]> {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const offset = (page - 1) * limit;

    let query = `SELECT * FROM tasks WHERE 1=1`;
    const params: (string | number)[] = [];

    if (filters.status) {
      query += ` AND status = ?`;
      params.push(filters.status);
    }

    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const result = await this.env.DB.prepare(query).bind(...params).all();
    return result.results as Task[];
  }

  async updateTask(id: string, data: Partial<Task>): Promise<Task | null> {
    const fields = Object.keys(data).filter(k => k !== 'id');
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => (data as any)[f]);

    await this.env.DB.prepare(`
      UPDATE tasks SET ${setClause}, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
    `).bind(...values, id).run();

    return this.getTask(id);
  }

  async deleteTask(id: string): Promise<boolean> {
    await this.env.DB.prepare(`DELETE FROM phase_subtasks WHERE task_id = ?`).bind(id).run();
    await this.env.DB.prepare(`DELETE FROM operation_logs WHERE task_id = ?`).bind(id).run();
    await this.env.DB.prepare(`DELETE FROM task_queue WHERE task_id = ?`).bind(id).run();
    await this.env.DB.prepare(`DELETE FROM frame_tasks WHERE task_id = ?`).bind(id).run();

    const result = await this.env.DB.prepare(
      `DELETE FROM tasks WHERE id = ?`
    ).bind(id).run();
    return result.changes > 0;
  }

  async startTask(id: string): Promise<Task | null> {
    const task = await this.getTask(id);
    if (!task) {
      return null;
    }

    if (task.status !== 'PENDING') {
      return null;
    }

    await this.triggerPhase(id, 'DETECT', undefined, undefined, 'DETECT', 'COMPOSE');
    return this.getTask(id);
  }

  async cancelTask(id: string): Promise<Task | null> {
    const task = await this.getTask(id);
    if (!task) {
      return null;
    }

    if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
      return task;
    }

    await this.env.DB.prepare(`
      UPDATE tasks SET status = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
    `).bind('CANCELLED', id).run();

    return this.getTask(id);
  }

  async retryTask(id: string): Promise<Task | null> {
    const task = await this.getTask(id);
    if (!task) {
      return null;
    }

    if (task.status !== 'FAILED') {
      return null;
    }

    await this.env.DB.prepare(`
      UPDATE tasks SET status = ?, retry_count = retry_count + 1, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
    `).bind('PENDING', id).run();

    await this.triggerPhase(id, task.current_phase as TaskPhase);
    return this.getTask(id);
  }

  async triggerPhase(taskId: string, phase: TaskPhase, ghAccountId?: number, aiAccountId?: number, startPhase?: TaskPhase, endPhase?: TaskPhase) {
    console.log('triggerPhase called:', { taskId, phase, ghAccountId, aiAccountId, startPhase, endPhase });
    
    const task = await this.getTask(taskId);
    if (!task) {
      console.error('triggerPhase: Task not found, taskId:', taskId);
      throw new Error('Task not found');
    }

    const accountService = await import('./AccountService');
    let ghAccount: any = ghAccountId ? null : null;
    let aiAccount: any = aiAccountId ? null : null;

    try {
      if (!ghAccountId) {
        ghAccount = await new accountService.AccountService(this.env).selectAvailableGitHubAccount();
        
        if (!ghAccount) {
          console.error('triggerPhase: No available GitHub account');
          throw new Error('No available GitHub account');
        }
        ghAccountId = ghAccount.id;
      }

      const effectiveStartPhase = startPhase || phase;
      const effectiveEndPhase = endPhase || phase;
      const isRangeExecution = effectiveStartPhase !== effectiveEndPhase;

      if (!isRangeExecution) {
        const requiredApiType = phasesRequiringAI[phase];
        if (requiredApiType) {
          if (!aiAccountId) {
            aiAccount = await new accountService.AccountService(this.env).selectAIAccountForGitHub(ghAccountId, requiredApiType);
            if (!aiAccount) {
              console.error('triggerPhase: No available AI account for phase:', phase);
              throw new Error('No available AI account');
            }
            aiAccountId = aiAccount.id;
          }
        }

        await this.dispatchGitHubWorkflow(taskId, phase, ghAccountId, aiAccountId);
      } else {
        await this.dispatchRangeWorkflow(taskId, effectiveStartPhase, effectiveEndPhase, ghAccountId);
      }
      
      await this.env.DB.prepare(`
        UPDATE tasks SET github_account_id = ?, current_phase = ?, status = ?, start_phase = ?, end_phase = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).bind(ghAccountId, phase, phaseStatusMap[phase].running, effectiveStartPhase, effectiveEndPhase, taskId).run();

      if (aiAccountId) {
        await this.env.DB.prepare(`
          UPDATE tasks SET ai_account_id = ? WHERE id = ?
        `).bind(aiAccountId, taskId).run();
      }

      const logMsg = isRangeExecution 
        ? `Range execution triggered: ${effectiveStartPhase} to ${effectiveEndPhase}`
        : `Phase ${phase} triggered`;
      await this.logTask(taskId, phase, 'INFO', logMsg);
      console.log('triggerPhase completed successfully:', { taskId, phase, isRangeExecution });
    } catch (error) {
      console.error('triggerPhase: Failed to dispatch workflow:', error);
      const errMsg = (error as Error).message;

      if (aiAccountId) {
        try {
          await new accountService.AccountService(this.env).releaseAIAccount(aiAccountId);
          console.log('triggerPhase: Released AI account', aiAccountId, 'after failure');
        } catch (releaseErr) {
          console.error('triggerPhase: Failed to release AI account:', releaseErr);
        }
      }

      await this.env.DB.prepare(`
        UPDATE tasks SET status = ?, error_msg = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).bind('FAILED', errMsg, taskId).run();
      await this.logTask(taskId, phase, 'ERROR', `Failed to trigger phase ${phase}: ${errMsg}`);
      throw error;
    }
  }

  async dispatchGitHubWorkflow(taskId: string, phase: TaskPhase, ghAccountId?: number, aiAccountId?: number, startPhase?: TaskPhase, endPhase?: TaskPhase) {
    console.log('dispatchGitHubWorkflow called:', { taskId, phase, ghAccountId, aiAccountId, startPhase, endPhase });
    
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

      const storedToken = (accountResult as { token_encrypted: string }).token_encrypted;
      
      if (!storedToken) {
        console.error('dispatchGitHubWorkflow: GitHub account token is empty');
        throw new Error('GitHub account token is empty');
      }
      
      if (storedToken.startsWith('ghp_') || storedToken.startsWith('github_pat_')) {
        console.log('dispatchGitHubWorkflow: Token is plaintext, using directly');
        ghApiKey = storedToken;
      } else {
        try {
          ghApiKey = await this.cryptoService.decrypt(storedToken);
          console.log('dispatchGitHubWorkflow: Token decrypted successfully, length:', ghApiKey.length);
        } catch (decryptError) {
          console.log('dispatchGitHubWorkflow: Decryption failed, using stored token as plaintext');
          ghApiKey = storedToken;
        }
      }
      
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

    let aiApiKey = '';
    let aiBaseUrl = '';
    let aiAccountsJson = '';
    
    if (aiAccountId) {
      const aiAccountResult = await this.env.DB.prepare(`
        SELECT api_key_encrypted, base_url FROM ai_accounts WHERE id = ?
      `).bind(aiAccountId).first();

      if (aiAccountResult) {
        const storedKey = (aiAccountResult as { api_key_encrypted: string }).api_key_encrypted;
        if (storedKey) {
          try {
            aiApiKey = await this.cryptoService.decrypt(storedKey);
            console.log('dispatchGitHubWorkflow: AI API key decrypted successfully, length:', aiApiKey.length, 'starts with:', aiApiKey.substring(0, 4));
          } catch (decryptErr) {
            console.error('dispatchGitHubWorkflow: AI API key decryption failed:', (decryptErr as Error).message);
            console.log('dispatchGitHubWorkflow: Stored key length:', storedKey.length, 'starts with:', storedKey.substring(0, 4));
          }
        }
        aiBaseUrl = (aiAccountResult as { base_url: string }).base_url || '';
      }
    }

    const maxConcurrentConfigResult = await this.env.DB.prepare(`
      SELECT value FROM system_config WHERE key = 'max_concurrent_jobs_per_github_account'
    `).first();
    const maxConcurrent = maxConcurrentConfigResult ? parseInt((maxConcurrentConfigResult as { value: string }).value) : 2;

    const requiredApiType = phasesRequiringAI[phase];
    if (requiredApiType) {
      const result = await this.getDecryptedAIAccounts(requiredApiType, maxConcurrent, ghAccountId);
      aiAccountsJson = result.aiAccountsJson;
    }

    const eventType = phase.toLowerCase().replace(/_/g, '-');
    const payload = {
      event_type: `video-processing-${eventType}`,
      client_payload: {
        task_id: taskId,
        phase: phase,
        start_phase: startPhase || phase,
        end_phase: endPhase || phase,
        gh_account_id: ghAccountId,
        ai_api_key: aiApiKey,
        ai_base_url: aiBaseUrl,
        ai_accounts: aiAccountsJson,
        config: JSON.stringify({
          video_path: task.video_path,
          fps: task.fps,
          prompt: task.prompt,
          output_fps: task.output_fps,
          max_concurrent: maxConcurrent,
        }),
      },
    };

    console.log('dispatchGitHubWorkflow: owner:', JSON.stringify(owner), 'repo:', JSON.stringify(repo));

    const authHeader = ghApiKey.startsWith('ghp_')
      ? `token ${ghApiKey}`
      : `Bearer ${ghApiKey}`;

    const githubUrl = `https://api.github.com/repos/${owner}/${repo}/dispatches`;
    console.log('dispatchGitHubWorkflow: Full URL:', githubUrl);
    console.log('dispatchGitHubWorkflow: event_type:', payload.event_type);

    const payloadStr = JSON.stringify(payload);
    console.log('dispatchGitHubWorkflow: payload size:', payloadStr.length, 'bytes');
    console.log('dispatchGitHubWorkflow: client_payload field count:', Object.keys(payload.client_payload).length);
    console.log('dispatchGitHubWorkflow: ai_api_key length:', aiApiKey.length, 'ai_base_url length:', aiBaseUrl.length);
    console.log('dispatchGitHubWorkflow: ai_accounts length:', aiAccountsJson.length);
    
    const response = await fetch(githubUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
        'User-Agent': 'AI-Video-Processor',
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });

    console.log('dispatchGitHubWorkflow: Response status:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('dispatchGitHubWorkflow: GitHub API error:', { status: response.status, errorText });
      throw new Error(`Failed to dispatch workflow: ${response.status} ${errorText}`);
    }

    console.log('dispatchGitHubWorkflow: GitHub workflow dispatched successfully for task', taskId);
    console.log('dispatchGitHubWorkflow: event_type sent:', eventType);
  }

  async dispatchRangeWorkflow(taskId: string, startPhase: TaskPhase, endPhase: TaskPhase, ghAccountId: number) {
    console.log('dispatchRangeWorkflow called:', { taskId, startPhase, endPhase, ghAccountId });
    
    const owner = this.env.GITHUB_REPO_OWNER;
    const repo = this.env.GITHUB_REPO_NAME;
    
    if (!owner || !repo) {
      console.error('dispatchRangeWorkflow: GitHub repository not configured');
      throw new Error('GitHub repository not configured');
    }

    let ghApiKey = '';
    const accountResult = await this.env.DB.prepare(`
      SELECT token_encrypted FROM github_accounts WHERE id = ?
    `).bind(ghAccountId).first();

    if (!accountResult) {
      console.error('dispatchRangeWorkflow: GitHub account not found, id:', ghAccountId);
      throw new Error('GitHub account not found');
    }

    const storedToken = (accountResult as { token_encrypted: string }).token_encrypted;
    
    if (!storedToken) {
      console.error('dispatchRangeWorkflow: GitHub account token is empty');
      throw new Error('GitHub account token is empty');
    }
    
    if (storedToken.startsWith('ghp_') || storedToken.startsWith('github_pat_')) {
      console.log('dispatchRangeWorkflow: Token is plaintext, using directly');
      ghApiKey = storedToken;
    } else {
      try {
        ghApiKey = await this.cryptoService.decrypt(storedToken);
        console.log('dispatchRangeWorkflow: Token decrypted successfully, length:', ghApiKey.length);
      } catch (decryptError) {
        console.log('dispatchRangeWorkflow: Decryption failed, using stored token as plaintext');
        ghApiKey = storedToken;
      }
    }

    const task = await this.getTask(taskId);
    if (!task) {
      console.error('dispatchRangeWorkflow: Task not found, taskId:', taskId);
      throw new Error('Task not found');
    }

    const maxConcurrentConfigResult = await this.env.DB.prepare(`
      SELECT value FROM system_config WHERE key = 'max_concurrent_jobs_per_github_account'
    `).first();
    const maxConcurrent = maxConcurrentConfigResult ? parseInt((maxConcurrentConfigResult as { value: string }).value) : 2;

    let aiAccountsJson = '';
    let primaryAiApiKey = '';
    let primaryAiBaseUrl = '';
    
    const startIndex = phaseOrder.indexOf(startPhase);
    const endIndex = phaseOrder.indexOf(endPhase);
    
    const seenApiTypes = new Set<string>();
    for (let i = startIndex; i <= endIndex; i++) {
      const currentPhase = phaseOrder[i];
      const requiredApiType = phasesRequiringAI[currentPhase];
      if (requiredApiType && !seenApiTypes.has(requiredApiType)) {
        seenApiTypes.add(requiredApiType);
        const result = await this.getDecryptedAIAccounts(requiredApiType, maxConcurrent, ghAccountId);
        if (result.aiAccountsJson) {
          const newAccounts = JSON.parse(result.aiAccountsJson);
          const existingAccounts = aiAccountsJson ? JSON.parse(aiAccountsJson) : [];
          existingAccounts.push(...newAccounts);
          aiAccountsJson = JSON.stringify(existingAccounts);
        }
        if (!primaryAiApiKey && result.aiApiKey) {
          primaryAiApiKey = result.aiApiKey;
          primaryAiBaseUrl = result.aiBaseUrl || '';
        }
      }
    }

    const payload = {
      event_type: 'video-processing-range',
      client_payload: {
        task_id: taskId,
        start_phase: startPhase,
        end_phase: endPhase,
        gh_account_id: ghAccountId,
        ai_accounts: aiAccountsJson,
        ai_api_key: primaryAiApiKey,
        ai_base_url: primaryAiBaseUrl,
        config: JSON.stringify({
          video_path: task.video_path,
          fps: task.fps,
          prompt: task.prompt,
          output_fps: task.output_fps,
          max_concurrent: maxConcurrent,
        }),
      },
    };

    console.log('dispatchRangeWorkflow: owner:', JSON.stringify(owner), 'repo:', JSON.stringify(repo));

    const authHeader = ghApiKey.startsWith('ghp_')
      ? `token ${ghApiKey}`
      : `Bearer ${ghApiKey}`;

    const githubUrl = `https://api.github.com/repos/${owner}/${repo}/dispatches`;
    console.log('dispatchRangeWorkflow: Full URL:', githubUrl);
    console.log('dispatchRangeWorkflow: event_type:', payload.event_type);

    const payloadStr = JSON.stringify(payload);
    console.log('dispatchRangeWorkflow: payload size:', payloadStr.length, 'bytes');
    console.log('dispatchRangeWorkflow: ai_accounts length:', aiAccountsJson.length);
    
    const response = await fetch(githubUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
        'User-Agent': 'AI-Video-Processor',
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });

    console.log('dispatchRangeWorkflow: Response status:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('dispatchRangeWorkflow: GitHub API error:', { status: response.status, errorText });
      throw new Error(`Failed to dispatch range workflow: ${response.status} ${errorText}`);
    }

    console.log('dispatchRangeWorkflow: GitHub range workflow dispatched successfully for task', taskId);
  }

  async updateTaskProgress(body: any) {
    const { task_id: taskId, phase, processed_count: processedCount, total_count: totalCount, failed_count: failedCount, message } = body;

    console.log('updateTaskProgress called:', { taskId, phase, processedCount, totalCount, failedCount, message });

    const progress = totalCount > 0 ? Math.round((processedCount / totalCount) * 100) : 0;

    await this.env.DB.prepare(`
      UPDATE tasks SET progress = ?, processed_frames = ?, total_frames = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind(progress, processedCount, totalCount, taskId).run();

    if (failedCount) {
      await this.env.DB.prepare(`
        UPDATE tasks SET failed_frames = ? WHERE id = ?
      `).bind(failedCount, taskId).run();
    }

    if (message) {
      await this.env.DB.prepare(`
        UPDATE tasks SET status_message = ? WHERE id = ?
      `).bind(message, taskId).run();
    }

    console.log('updateTaskProgress: Progress updated for task', taskId);
    return { success: true, taskId, progress };
  }

  async handleTaskComplete(body: any) {
    const { task_id: taskId, phase, data } = body;
    
    console.log('handleTaskComplete called:', { taskId, phase, data });
    
    await this.env.DB.prepare(`
      UPDATE tasks SET status = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind('COMPLETED', taskId).run();
    
    await this.env.DB.prepare(`
      UPDATE ai_accounts SET cooldown_until = NULL 
      WHERE cooldown_until IS NOT NULL
    `).run();
    console.log('handleTaskComplete: Released all locked AI accounts');
    
    await this.logTask(taskId, phase, 'INFO', `Task completed: ${JSON.stringify(data)}`);
    console.log('handleTaskComplete: Task marked as completed:', taskId);
    return { success: true, taskId };
  }

  async handleTaskError(body: any) {
    const { task_id: taskId, phase, error } = body;
    
    console.log('handleTaskError called:', { taskId, phase, error });
    
    await this.env.DB.prepare(`
      UPDATE tasks SET status = ?, failed_frames = failed_frames + 1, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind('FAILED', taskId).run();
    
    await this.env.DB.prepare(`
      UPDATE ai_accounts SET cooldown_until = NULL 
      WHERE cooldown_until IS NOT NULL
    `).run();
    console.log('handleTaskError: Released all locked AI accounts');
    
    await this.logTask(taskId, phase, 'ERROR', `Task error: ${error}`);
    console.log('handleTaskError: Task marked as failed:', taskId);
    return { success: true, taskId };
  }

  async handleAccountError(body: any) {
    const { task_id: taskId, account_id: accountId, error_type: errorType, message: errorMsg } = body;
    
    console.log('handleAccountError called:', { taskId, accountId, errorType, errorMsg });
    
    const accountService = new (await import('./AccountService')).AccountService(this.env);
    
    await accountService.markAccountUnhealthy(accountId, errorMsg || errorType);
    await accountService.releaseAIAccount(accountId);
    
    await this.logTask(taskId, 'ACCOUNT', 'WARNING', `AI账户 ${accountId} 标记为不健康: ${errorType} - ${errorMsg}`);
    
    const task = await this.getTask(taskId);
    if (task && task.github_account_id) {
      const requiredApiType = phasesRequiringAI[task.current_phase as TaskPhase];
      const newAccount = await accountService.selectAIAccountForGitHub(task.github_account_id, requiredApiType);
      
      if (newAccount) {
        await this.env.DB.prepare(`
          UPDATE tasks SET ai_account_id = ? WHERE id = ?
        `).bind(newAccount.id, taskId).run();
        
        console.log('handleAccountError: Replaced AI account', accountId, 'with', newAccount.id);
        await this.logTask(taskId, 'ACCOUNT', 'INFO', `AI账户已更换: ${accountId} → ${newAccount.id}`);
        
        return { success: true, new_account: newAccount };
      }
    }
    
    await this.env.DB.prepare(`
      UPDATE tasks SET status = ?, error_msg = ? WHERE id = ?
    `).bind('FAILED', `AI账户失效且无可用备用账户: ${errorType}`, taskId).run();
    
    await this.logTask(taskId, 'ACCOUNT', 'ERROR', `AI账户失效且无可用备用账户: ${errorType}`);
    
    return { success: false, message: 'No available AI accounts' };
  }

  async handleGitHubCallback(body: any) {
    const { task_id: taskId, phase, status, run_id: runId, start_phase: startPhase, end_phase: endPhase } = body;

    console.log('handleGitHubCallback called:', { taskId, phase, status, runId, startPhase, endPhase });

    const task = await this.getTask(taskId);
    if (task) {
      if (task.ai_account_id) {
        const accountService = new (await import('./AccountService')).AccountService(this.env);
        await accountService.releaseAIAccount(task.ai_account_id);
        console.log('handleGitHubCallback: Released AI account', task.ai_account_id);
      }
      if (task.github_account_id) {
        await this.env.DB.prepare(`
          UPDATE github_accounts SET monthly_used_minutes = monthly_used_minutes + 1
          WHERE id = ?
        `).bind(task.github_account_id).run();
      }
    }

    await this.env.DB.prepare(`
      UPDATE tasks SET current_run_id = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind(runId, taskId).run();

    if (status === 'success') {
      try {
        if (startPhase && endPhase && startPhase !== endPhase) {
          console.log('handleGitHubCallback: Range execution completed, marking task as completed');
          await this.env.DB.prepare(`
            UPDATE tasks SET status = ?, completed_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?
          `).bind('COMPLETED', taskId).run();
          await this.env.DB.prepare(`
            UPDATE ai_accounts SET cooldown_until = NULL 
            WHERE cooldown_until IS NOT NULL
          `).run();
          console.log('handleGitHubCallback: Released all locked AI accounts for range execution');
          await this.logTask(taskId, phase, 'INFO', `Range execution completed: ${startPhase} to ${endPhase}`);
        } else {
          await this.advancePhase(taskId);
        }
      } catch (error) {
        console.error('handleGitHubCallback: Failed to process completion:', error);
        await this.env.DB.prepare(`
          UPDATE tasks SET status = ?, error_msg = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?
        `).bind('FAILED', (error as Error).message, taskId).run();
      }
    } else {
      await this.env.DB.prepare(`
        UPDATE tasks SET status = ?, failed_frames = failed_frames + 1, error_msg = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).bind('FAILED', `Phase ${phase} failed in GitHub Actions run ${runId}`, taskId).run();

      await this.env.DB.prepare(`
        UPDATE ai_accounts SET cooldown_until = NULL 
        WHERE cooldown_until IS NOT NULL
      `).run();
      console.log('handleGitHubCallback: Released all locked AI accounts after failure');

      await this.logTask(taskId, phase, 'ERROR', `Phase ${phase} failed`);
    }
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

    // 释放上一阶段锁定的 AI 账户，确保下一阶段可以正常获取账户
    await this.env.DB.prepare(`
      UPDATE ai_accounts SET cooldown_until = NULL 
      WHERE cooldown_until IS NOT NULL
    `).run();
    console.log('advancePhase: Released all locked AI accounts before next phase');

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
    return result.results || [];
  }

  async updateProgress(taskId: string, phase: string, processedCount: number, totalCount: number) {
    const progress = totalCount > 0 ? Math.round((processedCount / totalCount) * 100) : 0;
    
    await this.env.DB.prepare(`
      UPDATE tasks SET progress = ?, processed_frames = ?, total_frames = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind(progress, processedCount, totalCount, taskId).run();
  }

  async getPhaseSubtasks(taskId: string, phase?: string) {
    let query = 'SELECT * FROM phase_subtasks WHERE task_id = ?';
    const params: (string | number)[] = [taskId];
    
    if (phase) {
      query += ' AND phase = ?';
      params.push(phase);
    }
    
    query += ' ORDER BY phase, subtask_index';
    
    const result = await this.env.DB.prepare(query).bind(...params).all();
    return result.results || [];
  }

  async createPhaseSubtask(taskId: string, phase: string, subtaskIndex: number, subtaskType: string, inputPath?: string, metadata?: string) {
    await this.env.DB.prepare(`
      INSERT OR IGNORE INTO phase_subtasks (task_id, phase, subtask_index, subtask_type, input_path, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(taskId, phase, subtaskIndex, subtaskType, inputPath || '', metadata || '').run();
  }

  async updatePhaseSubtaskStatus(taskId: string, phase: string, subtaskIndex: number, status: string, outputPath?: string, errorMsg?: string) {
    await this.env.DB.prepare(`
      UPDATE phase_subtasks SET status = ?, output_path = ?, error_msg = ?, 
        completed_at = CASE WHEN status = 'COMPLETED' THEN STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE completed_at END,
        started_at = CASE WHEN status = 'PROCESSING' THEN STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE started_at END,
        retry_count = CASE WHEN status = 'FAILED' THEN retry_count + 1 ELSE retry_count END
      WHERE task_id = ? AND phase = ? AND subtask_index = ?
    `).bind(status, outputPath || '', errorMsg || '', taskId, phase, subtaskIndex).run();
  }

  async runSubtask(taskId: string, phase: string, subtaskIndex: number) {
    const subtaskResult = await this.env.DB.prepare(`
      SELECT * FROM phase_subtasks WHERE task_id = ? AND phase = ? AND subtask_index = ?
    `).bind(taskId, phase, subtaskIndex).first();
    
    if (!subtaskResult) {
      throw new Error('Subtask not found');
    }
    
    const subtask = subtaskResult as any;
    
    await this.updatePhaseSubtaskStatus(taskId, phase, subtaskIndex, 'PROCESSING');
    
    const task = await this.getTask(taskId);
    if (!task || !task.github_account_id) {
      throw new Error('Task or GitHub account not found');
    }
    
    let aiAccountsJson = '';
    const ghAccountId = task.github_account_id;
    
    const maxConcurrentConfigResult = await this.env.DB.prepare(`
      SELECT value FROM system_config WHERE key = 'max_concurrent_jobs_per_github_account'
    `).first();
    const maxConcurrent = maxConcurrentConfigResult ? parseInt((maxConcurrentConfigResult as { value: string }).value) : 2;
    
    let aiApiKey = '';
    let aiBaseUrl = '';
    
    const requiredApiType = phasesRequiringAI[phase as TaskPhase];
    if (requiredApiType) {
      const result = await this.getDecryptedAIAccounts(requiredApiType, maxConcurrent, ghAccountId);
      aiAccountsJson = result.aiAccountsJson;
      aiApiKey = result.aiApiKey;
      aiBaseUrl = result.aiBaseUrl;
    }
    
    const subtaskData = {
      task_id: taskId,
      phase: phase,
      subtask_index: subtaskIndex,
      gh_account_id: ghAccountId,
      ai_api_key: aiApiKey,
      ai_base_url: aiBaseUrl,
      ai_accounts: aiAccountsJson,
      config: JSON.stringify({
        video_path: task.video_path,
        fps: task.fps,
        prompt: task.prompt,
        output_fps: task.output_fps,
        max_concurrent: maxConcurrent,
        subtask_type: subtask.subtask_type,
        input_path: subtask.input_path,
        metadata: subtask.metadata,
      }),
    };
    
    const owner = this.env.GITHUB_REPO_OWNER;
    const repo = this.env.GITHUB_REPO_NAME;
    
    const ghAccountResult = await this.env.DB.prepare(`
      SELECT token_encrypted FROM github_accounts WHERE id = ?
    `).bind(ghAccountId).first();
    
    if (!ghAccountResult) {
      throw new Error('GitHub account not found');
    }
    
    const storedToken = (ghAccountResult as { token_encrypted: string }).token_encrypted;
    let ghApiKey = storedToken;
    if (!storedToken.startsWith('ghp_') && !storedToken.startsWith('github_pat_')) {
      try {
        ghApiKey = await this.cryptoService.decrypt(storedToken);
      } catch {
        ghApiKey = storedToken;
      }
    }
    
    const authHeader = ghApiKey.startsWith('ghp_')
      ? `token ${ghApiKey}`
      : `Bearer ${ghApiKey}`;
    
    const payload = {
      event_type: `video-processing-subtask-${phase.toLowerCase().replace(/_/g, '-')}`,
      client_payload: subtaskData,
    };
    
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
        'User-Agent': 'AI-Video-Processor',
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to dispatch subtask workflow: ${response.status} ${errorText}`);
    }
    
    return { success: true, message: 'Subtask dispatched successfully' };
  }

  private async lockAIAccounts(apiType?: string, limit?: number, ghAccountId?: string): Promise<any[]> {
    const lockTime = new Date(Date.now() + 3600 * 1000);
    const typeCondition = apiType ? ' AND ai_accounts.api_type = ?' : '';
    const selectTypeCondition = apiType ? ' AND aa.api_type = ?' : '';
    const params: (string | number)[] = [];
    
    const lockQuery = `
      UPDATE ai_accounts
      SET cooldown_until = ?
      WHERE is_active = TRUE 
        AND is_healthy = TRUE
        AND (cooldown_until IS NULL OR cooldown_until < STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ${typeCondition}
        AND EXISTS (
          SELECT 1 FROM github_ai_bindings gab 
          WHERE gab.ai_account_id = ai_accounts.id AND gab.is_active = TRUE
        )
      ORDER BY 
        CASE WHEN ${ghAccountId ? 'EXISTS (SELECT 1 FROM github_ai_bindings gab2 WHERE gab2.ai_account_id = ai_accounts.id AND gab2.github_account_id = ? AND gab2.is_active = TRUE)' : 'FALSE'} THEN 0 ELSE 1 END,
        last_used_at ASC NULLS FIRST,
        total_usage ASC
      LIMIT ?
    `;
    
    params.push(lockTime.toISOString());
    if (apiType) params.push(apiType);
    if (ghAccountId) params.push(ghAccountId);
    params.push(limit || 1);
    
    await this.env.DB.prepare(lockQuery).bind(...params).run();
    
    const selectQuery = `
      SELECT aa.id, aa.api_key_encrypted, aa.base_url, aa.model_name, aa.account_alias, aa.api_type 
      FROM ai_accounts aa
      WHERE is_active = TRUE 
        AND cooldown_until = ?
        ${selectTypeCondition}
    `;
    const selectParams: (string | number)[] = [lockTime.toISOString()];
    if (apiType) selectParams.push(apiType);
    
    const result = await this.env.DB.prepare(selectQuery).bind(...selectParams).all();
    return result.results || [];
  }

  private async getDecryptedAIAccounts(apiType: string, maxConcurrent: number, ghAccountId: number): Promise<{
    aiAccountsJson: string;
    aiApiKey: string;
    aiBaseUrl: string;
  }> {
    const lockedAccounts = await this.lockAIAccounts(apiType, maxConcurrent, ghAccountId);
    if (lockedAccounts.length === 0) {
      return { aiAccountsJson: '', aiApiKey: '', aiBaseUrl: '' };
    }
    const decryptedAccounts = await Promise.all(
      (lockedAccounts as any[]).map(async (acc) => {
        let decryptedKey = '';
        if (acc.api_key_encrypted) {
          try {
            decryptedKey = await this.cryptoService.decrypt(acc.api_key_encrypted);
          } catch (decryptErr) {
            console.error('getDecryptedAIAccounts: Failed to decrypt API key for account', acc.id || acc.account_alias, ':', (decryptErr as Error).message);
          }
        }
        return {
          ...acc,
          api_key_encrypted: decryptedKey,
          base_url: (acc.base_url || '').trim(),
          model_name: (acc.model_name || '').trim()
        };
      })
    );
    return {
      aiAccountsJson: JSON.stringify(decryptedAccounts),
      aiApiKey: decryptedAccounts[0].api_key_encrypted,
      aiBaseUrl: decryptedAccounts[0].base_url || ''
    };
  }

  private generateUUID(): string {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    array[6] = (array[6] & 0x0f) | 0x40;
    array[8] = (array[8] & 0x3f) | 0x80;
    return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
}
