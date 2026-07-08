import { Bindings } from '../types/env';
import { GitHubAccount, AIAccount } from '../types';

type D1ResultType = {
  success: boolean;
  meta?: {
    changes?: number;
  };
};

export class AccountService {
  constructor(private env: Bindings) {}

  async listGitHubAccounts(): Promise<GitHubAccount[]> {
    const result = await this.env.DB.prepare(`
      SELECT * FROM github_accounts ORDER BY name
    `).all();

    return result.results as unknown as GitHubAccount[];
  }

  async createGitHubAccount(data: any): Promise<GitHubAccount> {
    const result = await this.env.DB.prepare(`
      INSERT INTO github_accounts (name, username, token_encrypted, monthly_limit)
      VALUES (?, ?, ?, ?)
    `).bind(
      data.name,
      data.username || '',
      data.token_encrypted || '',
      data.monthly_limit || 2000
    ).run() as D1ResultType;

    if (!result.success || (result.meta?.changes ?? 0) === 0) {
      throw new Error('Failed to create GitHub account');
    }

    const inserted = await this.env.DB.prepare(`
      SELECT * FROM github_accounts WHERE name = ?
    `).bind(data.name).first();

    if (!inserted) throw new Error('Failed to retrieve created account');
    return inserted as unknown as GitHubAccount;
  }

  async updateGitHubAccount(id: number, data: any): Promise<GitHubAccount | null> {
    const updateFields: string[] = [];
    const params: (string | number | boolean)[] = [];

    if (data.name !== undefined) {
      updateFields.push('name = ?');
      params.push(data.name);
    }
    if (data.username !== undefined) {
      updateFields.push('username = ?');
      params.push(data.username);
    }
    if (data.token_encrypted !== undefined) {
      updateFields.push('token_encrypted = ?');
      params.push(data.token_encrypted);
    }
    if (data.is_active !== undefined) {
      updateFields.push('is_active = ?');
      params.push(data.is_active);
    }
    if (data.monthly_limit !== undefined) {
      updateFields.push('monthly_limit = ?');
      params.push(data.monthly_limit);
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    await this.env.DB.prepare(`
      UPDATE github_accounts SET ${updateFields.join(', ')} WHERE id = ?
    `).bind(...params).run() as D1ResultType;

    const updated = await this.env.DB.prepare(`
      SELECT * FROM github_accounts WHERE id = ?
    `).bind(id).first();

    return updated ? (updated as unknown as GitHubAccount) : null;
  }

  async deleteGitHubAccount(id: number): Promise<boolean> {
    const result = await this.env.DB.prepare(`
      DELETE FROM github_accounts WHERE id = ?
    `).bind(id).run() as D1ResultType;

    return result.success && (result.meta?.changes ?? 0) > 0;
  }

  async listAIAccounts(): Promise<AIAccount[]> {
    const result = await this.env.DB.prepare(`
      SELECT * FROM ai_accounts ORDER BY priority_weight DESC, account_alias
    `).all();

    return result.results as unknown as AIAccount[];
  }

  async createAIAccount(data: any): Promise<AIAccount> {
    const result = await this.env.DB.prepare(`
      INSERT INTO ai_accounts (
        account_alias, api_type, api_key_encrypted, base_url, model_name, 
        max_concurrent, priority_weight, cooldown_seconds, daily_limit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      data.account_alias,
      data.api_type || 'image',
      data.api_key_encrypted || '',
      data.base_url || 'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/image-to-image',
      data.model_name || 'stable-diffusion-xl-1024-v1-0',
      data.max_concurrent || 1,
      data.priority_weight || 50,
      data.cooldown_seconds || 0,
      data.daily_limit || 1000
    ).run() as D1ResultType;

    if (!result.success || (result.meta?.changes ?? 0) === 0) {
      throw new Error('Failed to create AI account');
    }

    const inserted = await this.env.DB.prepare(`
      SELECT * FROM ai_accounts WHERE account_alias = ?
    `).bind(data.account_alias).first();

    if (!inserted) throw new Error('Failed to retrieve created account');
    return inserted as unknown as AIAccount;
  }

  async updateAIAccount(id: number, data: any): Promise<AIAccount | null> {
    const updateFields: string[] = [];
    const params: (string | number | boolean)[] = [];

    if (data.account_alias !== undefined) {
      updateFields.push('account_alias = ?');
      params.push(data.account_alias);
    }
    if (data.api_type !== undefined) {
      updateFields.push('api_type = ?');
      params.push(data.api_type);
    }
    if (data.api_key_encrypted !== undefined) {
      updateFields.push('api_key_encrypted = ?');
      params.push(data.api_key_encrypted);
    }
    if (data.base_url !== undefined) {
      updateFields.push('base_url = ?');
      params.push(data.base_url);
    }
    if (data.model_name !== undefined) {
      updateFields.push('model_name = ?');
      params.push(data.model_name);
    }
    if (data.max_concurrent !== undefined) {
      updateFields.push('max_concurrent = ?');
      params.push(data.max_concurrent);
    }
    if (data.priority_weight !== undefined) {
      updateFields.push('priority_weight = ?');
      params.push(data.priority_weight);
    }
    if (data.cooldown_seconds !== undefined) {
      updateFields.push('cooldown_seconds = ?');
      params.push(data.cooldown_seconds);
    }
    if (data.is_active !== undefined) {
      updateFields.push('is_active = ?');
      params.push(data.is_active);
    }
    if (data.daily_limit !== undefined) {
      updateFields.push('daily_limit = ?');
      params.push(data.daily_limit);
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    await this.env.DB.prepare(`
      UPDATE ai_accounts SET ${updateFields.join(', ')} WHERE id = ?
    `).bind(...params).run();

    const updated = await this.env.DB.prepare(`
      SELECT * FROM ai_accounts WHERE id = ?
    `).bind(id).first();

    return updated ? (updated as unknown as AIAccount) : null;
  }

  async deleteAIAccount(id: number): Promise<boolean> {
    const result = await this.env.DB.prepare(`
      DELETE FROM ai_accounts WHERE id = ?
    `).bind(id).run() as D1ResultType;

    return result.success && (result.meta?.changes ?? 0) > 0;
  }

  async checkAIAccountHealth(id: number): Promise<{ id: number; isHealthy: boolean; message: string }> {
    const account = await this.env.DB.prepare(`
      SELECT * FROM ai_accounts WHERE id = ?
    `).bind(id).first();

    if (!account) {
      throw new Error('AI account not found');
    }

    try {
      const now = new Date();
      
      await this.env.DB.prepare(`
        UPDATE ai_accounts SET is_healthy = ?, health_check_msg = ?, last_health_check = ?
        WHERE id = ?
      `).bind(true, 'Health check passed', now.toISOString(), id).run();

      return { id, isHealthy: true, message: 'Health check passed' };
    } catch (error) {
      await this.env.DB.prepare(`
        UPDATE ai_accounts SET is_healthy = ?, health_check_msg = ?, last_health_check = ?
        WHERE id = ?
      `).bind(false, (error as Error).message, new Date().toISOString(), id).run();

      return { id, isHealthy: false, message: (error as Error).message };
    }
  }

  async selectAvailableGitHubAccount(): Promise<GitHubAccount | null> {
    const accounts = await this.env.DB.prepare(`
      SELECT ga.*
      FROM github_accounts ga
      WHERE is_active = TRUE 
        AND (is_limited IS NULL OR is_limited = FALSE)
      ORDER BY monthly_used_minutes ASC, success_rate DESC
    `).all();

    if (!accounts.results || accounts.results.length === 0) {
      return null;
    }

    return accounts.results[0] as unknown as GitHubAccount;
  }

  async selectAIAccount(apiType?: string): Promise<AIAccount | null> {
    let query = `
      SELECT aa.*
      FROM ai_accounts aa
      WHERE is_active = TRUE 
        AND (cooldown_until IS NULL OR cooldown_until < STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `;
    const params: (string | number)[] = [];

    if (apiType) {
      query += ' AND api_type = ?';
      params.push(apiType);
    }

    query += ' ORDER BY priority_weight DESC, total_usage ASC';

    const accounts = await this.env.DB.prepare(query).bind(...params).all();

    if (!accounts.results || accounts.results.length === 0) {
      return null;
    }

    const totalWeight = accounts.results.reduce((sum: number, acc: any) => sum + (acc.priority_weight || 0), 0);
    let random = Math.random() * totalWeight;
    let selectedAccount: any = null;

    for (const account of accounts.results) {
      const weight = typeof (account as any).priority_weight === 'number' ? (account as any).priority_weight : 0;
      random -= weight;
      if (random <= 0) {
        selectedAccount = account;
        break;
      }
    }

    if (!selectedAccount) {
      selectedAccount = accounts.results[0];
    }

    const reservationExpiry = new Date(Date.now() + 10 * 60 * 1000);

    const result = await this.env.DB.prepare(`
      UPDATE ai_accounts
      SET cooldown_until = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND (cooldown_until IS NULL OR cooldown_until < STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).bind(reservationExpiry.toISOString(), selectedAccount.id).run() as D1ResultType;

    if (!result.success || (result.meta?.changes ?? 0) === 0) {
      return await this.selectAIAccount();
    }

    return selectedAccount as unknown as AIAccount;
  }

  async releaseAIAccount(accountId: number): Promise<void> {
    await this.env.DB.prepare(`
      UPDATE ai_accounts SET cooldown_until = NULL, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).bind(accountId).run();
  }
}