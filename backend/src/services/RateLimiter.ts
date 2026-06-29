import { Bindings } from '../types/env';

export class RateLimiter {
  constructor(private env: Bindings) {}

  async checkLimit(key: string, maxRequests: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
    const windowKey = `${key}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
    
    try {
      const current = await this.env.KV.get(windowKey);
      const count = current ? parseInt(current) : 0;

      if (count >= maxRequests) {
        return {
          allowed: false,
          remaining: 0,
          resetTime: Date.now() + windowSeconds * 1000,
        };
      }

      await this.env.KV.put(windowKey, String(count + 1), {
        expirationTtl: windowSeconds,
      });

      return {
        allowed: true,
        remaining: maxRequests - count - 1,
        resetTime: Date.now() + windowSeconds * 1000,
      };
    } catch {
      return {
        allowed: true,
        remaining: maxRequests - 1,
        resetTime: Date.now() + windowSeconds * 1000,
      };
    }
  }

  async checkAIAccountLimit(aiAccountId: number): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
    const windowSecondsResult = await this.env.DB.prepare(`
      SELECT value FROM system_config WHERE key = 'ai_rate_limit_window'
    `).first();

    const maxRequestsResult = await this.env.DB.prepare(`
      SELECT value FROM system_config WHERE key = 'ai_rate_limit_max_requests'
    `).first();

    const window = windowSecondsResult ? parseInt((windowSecondsResult as { value: string }).value) : 60;
    const max = maxRequestsResult ? parseInt((maxRequestsResult as { value: string }).value) : 100;

    return await this.checkLimit(`ai:${aiAccountId}`, max, window);
  }

  async checkGlobalLimit(): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
    return await this.checkLimit('global', 1000, 60);
  }

  async checkIPLimit(ip: string): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
    return await this.checkLimit(`ip:${ip}`, 100, 60);
  }

  async checkAPILimit(apiKey: string): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
    return await this.checkLimit(`api:${apiKey}`, 500, 60);
  }

  async getLimitStats() {
    const global = await this.checkGlobalLimit();
    
    const aiAccountsResult = await this.env.DB.prepare(`
      SELECT id FROM ai_accounts WHERE is_active = TRUE
    `).all();

    const aiAccounts = aiAccountsResult.results as unknown as { id: number }[];

    const aiStats: Record<number, { allowed: boolean; remaining: number; resetTime: number }> = {};
    for (const account of aiAccounts) {
      aiStats[account.id] = await this.checkAIAccountLimit(account.id);
    }

    return {
      global,
      aiAccounts: aiStats,
    };
  }
}