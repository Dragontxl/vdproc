import { Bindings } from '../types/env';

interface AlertRule {
  id: number;
  name: string;
  description?: string;
  metric_name: string;
  condition: string;
  severity: string;
  is_active: boolean;
  cooldown_seconds?: number;
  last_triggered_at?: string;
}

function evaluateCondition(value: number, condition: string): boolean {
  const operators = ['>=', '<=', '>', '<', '==', '!='];
  
  for (const op of operators) {
    if (condition.includes(op)) {
      const parts = condition.split(op);
      if (parts.length === 2) {
        const compareValue = parseFloat(parts[1].trim());
        switch (op) {
          case '>=': return value >= compareValue;
          case '<=': return value <= compareValue;
          case '>': return value > compareValue;
          case '<': return value < compareValue;
          case '==': return value === compareValue;
          case '!=': return value !== compareValue;
        }
      }
    }
  }
  
  return false;
}

export class MonitoringService {
  constructor(private env: Bindings) {}

  async recordMetric(name: string, value: number, labels?: Record<string, string>) {
    await this.env.DB.prepare(`
      INSERT INTO metrics (metric_name, metric_value, labels, timestamp)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(name, value, labels ? JSON.stringify(labels) : null).run();
  }

  async getMetricHistory(name: string, hours: number = 24) {
    const result = await this.env.DB.prepare(`
      SELECT metric_value, timestamp FROM metrics 
      WHERE metric_name = ? AND timestamp >= DATETIME('now', '-${hours} hours')
      ORDER BY timestamp ASC
    `).bind(name).all();

    return result.results;
  }

  async getCurrentMetric(name: string): Promise<number> {
    const result = await this.env.DB.prepare(`
      SELECT metric_value FROM metrics 
      WHERE metric_name = ? ORDER BY timestamp DESC LIMIT 1
    `).bind(name).first();

    return result ? parseFloat((result as { metric_value: string }).metric_value) : 0;
  }

  async checkAlerts() {
    const rulesResult = await this.env.DB.prepare(`
      SELECT * FROM alert_rules WHERE is_active = TRUE
    `).all();

    const rules = rulesResult.results as unknown as AlertRule[];
    const triggeredAlerts: AlertRule[] = [];

    for (const rule of rules) {
      const metric = await this.getCurrentMetric(rule.metric_name);
      if (metric === 0) continue;

      const shouldAlert = evaluateCondition(metric, rule.condition);

      if (shouldAlert) {
        const now = new Date();
        const lastTriggered = rule.last_triggered_at ? new Date(rule.last_triggered_at) : null;
        
        const cooldownSeconds = rule.cooldown_seconds ?? 3600;
        if (!lastTriggered || (now.getTime() - lastTriggered.getTime()) > cooldownSeconds * 1000) {
          await this.env.DB.prepare(`
            INSERT INTO alert_history (rule_id, message, severity)
            VALUES (?, ?, ?)
          `).bind(rule.id, rule.description || rule.name, rule.severity).run();

          await this.env.DB.prepare(`
            UPDATE alert_rules SET last_triggered_at = CURRENT_TIMESTAMP WHERE id = ?
          `).bind(rule.id).run();

          triggeredAlerts.push(rule);
        }
      }
    }

    return triggeredAlerts;
  }

  async getAlertHistory(limit: number = 100) {
    const result = await this.env.DB.prepare(`
      SELECT ah.*, ar.name as rule_name FROM alert_history ah
      JOIN alert_rules ar ON ah.rule_id = ar.id
      ORDER BY ah.triggered_at DESC LIMIT ?
    `).bind(limit).all();

    return result.results;
  }

  async createAlertRule(name: string, description: string, metricName: string, condition: string, severity: string = 'WARNING') {
    await this.env.DB.prepare(`
      INSERT INTO alert_rules (name, description, metric_name, condition, severity)
      VALUES (?, ?, ?, ?, ?)
    `).bind(name, description, metricName, condition, severity).run();

    return { success: true };
  }

  async deleteAlertRule(id: number) {
    await this.env.DB.prepare(`
      DELETE FROM alert_rules WHERE id = ?
    `).bind(id).run();

    return { success: true };
  }

  async collectSystemMetrics() {
    const pendingCount = await this.env.DB.prepare(`
      SELECT COUNT(*) as count FROM tasks WHERE status = 'PENDING'
    `).first();

    const processingCount = await this.env.DB.prepare(`
      SELECT COUNT(*) as count FROM tasks WHERE status IN ('EXTRACTING', 'IMG2IMGING', 'COMPOSING')
    `).first();

    const completedCount = await this.env.DB.prepare(`
      SELECT COUNT(*) as count FROM tasks WHERE status = 'COMPLETED' AND DATE(created_at) = DATE('now')
    `).first();

    const failedCount = await this.env.DB.prepare(`
      SELECT COUNT(*) as count FROM tasks WHERE status = 'FAILED' AND DATE(created_at) = DATE('now')
    `).first();

    const activeGitHubAccounts = await this.env.DB.prepare(`
      SELECT COUNT(*) as count FROM github_accounts WHERE is_active = TRUE
    `).first();

    const activeAIAccounts = await this.env.DB.prepare(`
      SELECT COUNT(*) as count FROM ai_accounts WHERE is_active = TRUE AND is_healthy = TRUE
    `).first();

    const pendingVal = pendingCount ? parseInt((pendingCount as { count: string }).count) : 0;
    const processingVal = processingCount ? parseInt((processingCount as { count: string }).count) : 0;
    const completedVal = completedCount ? parseInt((completedCount as { count: string }).count) : 0;
    const failedVal = failedCount ? parseInt((failedCount as { count: string }).count) : 0;
    const ghActiveVal = activeGitHubAccounts ? parseInt((activeGitHubAccounts as { count: string }).count) : 0;
    const aiActiveVal = activeAIAccounts ? parseInt((activeAIAccounts as { count: string }).count) : 0;

    await this.recordMetric('pending_tasks', pendingVal);
    await this.recordMetric('processing_tasks', processingVal);
    await this.recordMetric('daily_completed_tasks', completedVal);
    await this.recordMetric('daily_failed_tasks', failedVal);
    await this.recordMetric('active_github_accounts', ghActiveVal);
    await this.recordMetric('active_ai_accounts', aiActiveVal);

    return {
      pending_tasks: pendingVal,
      processing_tasks: processingVal,
      daily_completed_tasks: completedVal,
      daily_failed_tasks: failedVal,
      active_github_accounts: ghActiveVal,
      active_ai_accounts: aiActiveVal,
    };
  }
}