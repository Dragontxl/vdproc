import { Bindings } from '../types/env';

interface ConfigRow {
  key: string;
  value: string;
  description?: string;
}

type D1ResultType = {
  success: boolean;
  meta?: {
    changes?: number;
  };
};

export class ConfigService {
  constructor(private env: Bindings) {}

  async getAllConfigs(): Promise<ConfigRow[]> {
    const result = await this.env.DB.prepare(`
      SELECT * FROM system_config ORDER BY key
    `).all();

    return result.results as unknown as ConfigRow[];
  }

  async getConfig(key: string): Promise<ConfigRow | null> {
    const result = await this.env.DB.prepare(`
      SELECT * FROM system_config WHERE key = ?
    `).bind(key).first();

    return result ? (result as unknown as ConfigRow) : null;
  }

  async getConfigValue(key: string, defaultValue?: string): Promise<string> {
    const config = await this.getConfig(key);
    return config ? config.value : defaultValue || '';
  }

  async getConfigNumber(key: string, defaultValue?: number): Promise<number> {
    const config = await this.getConfig(key);
    return config ? parseFloat(config.value) : (defaultValue || 0);
  }

  async updateConfig(key: string, value: string): Promise<ConfigRow | null> {
    const result = await this.env.DB.prepare(`
      UPDATE system_config SET value = ?, updated_at = CURRENT_TIMESTAMP
      WHERE key = ?
    `).bind(value, key).run() as D1ResultType;

    if (!result.success || (result.meta?.changes ?? 0) === 0) {
      return null;
    }

    return await this.getConfig(key);
  }

  async createConfig(key: string, value: string, description?: string): Promise<ConfigRow> {
    const result = await this.env.DB.prepare(`
      INSERT INTO system_config (key, value, description) VALUES (?, ?, ?)
    `).bind(key, value, description || '').run() as D1ResultType;

    if (!result.success || (result.meta?.changes ?? 0) === 0) {
      throw new Error('Failed to create config');
    }

    const config = await this.getConfig(key);
    if (!config) throw new Error('Failed to retrieve created config');
    return config;
  }

  async deleteConfig(key: string): Promise<boolean> {
    const result = await this.env.DB.prepare(`
      DELETE FROM system_config WHERE key = ?
    `).bind(key).run() as D1ResultType;

    return result.success && (result.meta?.changes ?? 0) > 0;
  }

  async getMaxConcurrentTasks(): Promise<number> {
    return await this.getConfigNumber('max_concurrent_tasks', 5);
  }

  async getDefaultFPS(): Promise<number> {
    return await this.getConfigNumber('default_fps', 30);
  }

  async getFrameBatchSize(): Promise<number> {
    return await this.getConfigNumber('frame_batch_size', 10);
  }

  async getMaxRetryCount(): Promise<number> {
    return await this.getConfigNumber('max_retry_count', 3);
  }

  async getTaskExpireDays(): Promise<number> {
    return await this.getConfigNumber('task_expire_days', 7);
  }

  async isParallelProcessingEnabled(): Promise<boolean> {
    const value = await this.getConfigValue('enable_parallel_processing', 'true');
    return value.toLowerCase() === 'true';
  }

  async isCostTrackingEnabled(): Promise<boolean> {
    const value = await this.getConfigValue('enable_cost_tracking', 'true');
    return value.toLowerCase() === 'true';
  }

  async getDailyBudgetLimit(): Promise<number> {
    return await this.getConfigNumber('daily_budget_limit', 100);
  }

  async getAiCostPerRequest(): Promise<number> {
    return await this.getConfigNumber('ai_cost_per_request', 0.02);
  }
}