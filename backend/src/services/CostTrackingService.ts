import { Bindings } from '../types/env';

interface MetricRow {
  id: number;
  metric_value: number;
}

export class CostTrackingService {
  constructor(private env: Bindings) {}

  async recordAIRequest(aiAccountId: number, success: boolean, cost: number = 0.02) {
    await this.env.DB.prepare(`
      UPDATE ai_accounts 
      SET total_usage = total_usage + 1, 
          ${success ? 'success_rate = ((success_rate * total_calls) + 100) / (total_calls + 1), total_calls = total_calls + 1' : 'success_rate = (success_rate * total_calls) / (total_calls + 1), total_calls = total_calls + 1, failed_calls = failed_calls + 1'},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(aiAccountId).run();

    if (success) {
      await this.env.DB.prepare(`
        UPDATE ai_accounts 
        SET daily_usage = daily_usage + 1 
        WHERE id = ?
      `).bind(aiAccountId).run();

      await this.recordDailyCost(cost);
    }

    return { success: true };
  }

  async recordDailyCost(cost: number) {
    const today = new Date().toISOString().split('T')[0];
    
    const existing = await this.env.DB.prepare(`
      SELECT * FROM metrics 
      WHERE metric_name = 'daily_cost' AND DATE(timestamp) = ?
    `).bind(today).first() as MetricRow | null;

    if (existing) {
      await this.env.DB.prepare(`
        UPDATE metrics 
        SET metric_value = metric_value + ? 
        WHERE id = ?
      `).bind(cost, existing.id).run();
    } else {
      await this.env.DB.prepare(`
        INSERT INTO metrics (metric_name, metric_value, timestamp)
        VALUES ('daily_cost', ?, CURRENT_TIMESTAMP)
      `).bind(cost).run();
    }
  }

  async getDailyCost(date?: string): Promise<number> {
    const targetDate = date || new Date().toISOString().split('T')[0];
    
    const result = await this.env.DB.prepare(`
      SELECT COALESCE(SUM(metric_value), 0) as total FROM metrics
      WHERE metric_name = 'daily_cost' AND DATE(timestamp) = ?
    `).bind(targetDate).first();

    return result ? parseFloat((result as { total: string }).total) : 0;
  }

  async getMonthlyCost(month?: string): Promise<number> {
    const targetMonth = month || new Date().toISOString().slice(0, 7);
    
    const result = await this.env.DB.prepare(`
      SELECT COALESCE(SUM(metric_value), 0) as total FROM metrics
      WHERE metric_name = 'daily_cost' AND STRFTIME('%Y-%m', timestamp) = ?
    `).bind(targetMonth).first();

    return result ? parseFloat((result as { total: string }).total) : 0;
  }

  async checkBudget() {
    const dailyBudget = await this.env.DB.prepare(`
      SELECT value FROM system_config WHERE key = 'daily_budget_limit'
    `).first();

    const monthlyBudget = await this.env.DB.prepare(`
      SELECT value FROM system_config WHERE key = 'monthly_budget_limit'
    `).first();

    const dailyCost = await this.getDailyCost();
    const monthlyCost = await this.getMonthlyCost();

    const dailyLimit = dailyBudget ? parseFloat((dailyBudget as { value: string }).value) : 100;
    const monthlyLimit = monthlyBudget ? parseFloat((monthlyBudget as { value: string }).value) : 1000;

    const dailyUsagePercent = (dailyCost / dailyLimit) * 100;
    const monthlyUsagePercent = (monthlyCost / monthlyLimit) * 100;

    let status = 'OK';
    let message = '';

    if (dailyCost >= dailyLimit || monthlyCost >= monthlyLimit) {
      status = 'EXCEEDED';
      message = `Budget exceeded! Daily: $${dailyCost.toFixed(2)}/$${dailyLimit}, Monthly: $${monthlyCost.toFixed(2)}/$${monthlyLimit}`;
    } else if (dailyUsagePercent >= 80 || monthlyUsagePercent >= 80) {
      status = 'WARNING';
      message = `Budget approaching limit! Daily: ${Math.round(dailyUsagePercent)}%, Monthly: ${Math.round(monthlyUsagePercent)}%`;
    }

    return {
      dailyCost,
      dailyLimit,
      dailyUsagePercent,
      monthlyCost,
      monthlyLimit,
      monthlyUsagePercent,
      status,
      message,
    };
  }

  async getCostBreakdown() {
    const result = await this.env.DB.prepare(`
      SELECT aa.account_alias, aa.total_usage, aa.success_rate,
             (aa.total_usage * 0.02) as estimated_cost
      FROM ai_accounts aa
      ORDER BY total_usage DESC
    `).all();

    return result.results;
  }

  async resetDailyUsage() {
    const today = new Date().toISOString().split('T')[0];

    await this.env.DB.prepare(`
      UPDATE ai_accounts 
      SET daily_usage = 0, updated_at = CURRENT_TIMESTAMP
      WHERE DATE(updated_at) != ?
    `).bind(today).run();

    return { success: true };
  }
}