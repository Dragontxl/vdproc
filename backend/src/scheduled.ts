import type { ScheduledEvent } from '@cloudflare/workers-types';
import { TaskService } from './services/TaskService';
import { ConfigService } from './services/ConfigService';
import { AccountService } from './services/AccountService';
import { Bindings } from './types/env';

interface ConfigRow {
  value: string;
}

interface MetricRow {
  metric_value: string;
}

interface CountRow {
  count: number;
}

interface AlertRule {
  id: number;
  name: string;
  description?: string;
  metric_name: string;
  condition: string;
  severity: string;
  cooldown_seconds?: number;
  last_triggered_at?: string;
}

export async function scheduled(event: ScheduledEvent, env: Bindings) {
  const taskService = new TaskService(env);
  const configService = new ConfigService(env);
  const accountService = new AccountService(env);

  switch (event.cron) {
    case '*/5 * * * *':
      await processPendingTasks(taskService, configService, accountService);
      break;
    
    case '*/30 * * * *':
      await cleanupExpiredTasks(env);
      await checkBudgetLimits(env);
      break;
    
    case '0 * * * *':
      await resetGitHubAccountLimits(env);
      await logHourlyMetrics(env);
      break;
    
    case '0 0 * * *':
      await resetAIAccountDailyUsage(env);
      await checkAlertRules(env);
      break;
    
    default:
      console.log('Unknown cron schedule:', event.cron);
  }
}

async function processPendingTasks(
  taskService: TaskService,
  configService: ConfigService,
  accountService: AccountService
) {
  const maxConcurrent = await configService.getMaxConcurrentTasks();
  
  const pendingTasks = await taskService.listTasks({
    status: 'PENDING',
    page: 1,
    limit: maxConcurrent,
  });

  for (const task of pendingTasks) {
    const ghAccount = await accountService.selectAvailableGitHubAccount();
    const aiAccount = await accountService.selectAIAccount();

    if (!ghAccount || !aiAccount) {
      console.log('No available accounts for task:', task.id);
      continue;
    }

    try {
      await taskService.startTask(task.id);
      console.log('Started task:', task.id);
    } catch (error) {
      console.error('Failed to start task:', task.id, error);
    }
  }
}

async function cleanupExpiredTasks(env: Bindings) {
  const expireDaysResult = await env.DB.prepare(`
    SELECT value FROM system_config WHERE key = 'task_expire_days'
  `).first() as ConfigRow | null;

  const days = expireDaysResult ? parseInt(expireDaysResult.value) : 7;

  const expiredTasks = await env.DB.prepare(`
    SELECT id FROM tasks WHERE expires_at < CURRENT_TIMESTAMP
  `).all();

  const results = expiredTasks.results as unknown as { id: string }[];
  for (const task of results) {
    await env.DB.prepare(`DELETE FROM tasks WHERE id = ?`).bind(task.id).run();
    console.log('Cleaned up expired task:', task.id);
  }
}

async function checkBudgetLimits(env: Bindings) {
  const enabledResult = await env.DB.prepare(`
    SELECT value FROM system_config WHERE key = 'enable_cost_tracking'
  `).first() as ConfigRow | null;
  
  if (!enabledResult || enabledResult.value.toLowerCase() !== 'true') {
    return;
  }

  const dailyBudgetResult = await env.DB.prepare(`
    SELECT value FROM system_config WHERE key = 'daily_budget_limit'
  `).first() as ConfigRow | null;
  
  const dailyBudget = dailyBudgetResult ? parseFloat(dailyBudgetResult.value) : 100;
  
  const todayUsage = await env.DB.prepare(`
    SELECT COALESCE(SUM(metric_value), 0) as total FROM metrics
    WHERE metric_name = 'daily_cost' AND timestamp >= DATE('now')
  `).first() as { total: string } | null;

  const usage = todayUsage ? parseFloat(todayUsage.total) : 0;
  
  if (usage >= dailyBudget * 0.8) {
    console.log(`Warning: Daily budget at ${Math.round(usage / dailyBudget * 100)}%`);
  }
  
  if (usage >= dailyBudget) {
    console.log('Alert: Daily budget exceeded!');
  }
}

async function resetGitHubAccountLimits(env: Bindings) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  await env.DB.prepare(`
    UPDATE github_accounts 
    SET monthly_used_minutes = 0, last_reset_date = ?, updated_at = CURRENT_TIMESTAMP
    WHERE last_reset_date != ?
  `).bind(today, today).run();

  console.log('Reset GitHub account monthly limits');
}

async function resetAIAccountDailyUsage(env: Bindings) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  await env.DB.prepare(`
    UPDATE ai_accounts 
    SET daily_usage = 0, updated_at = CURRENT_TIMESTAMP
    WHERE DATE(updated_at) != ?
  `).bind(today).run();

  console.log('Reset AI account daily usage');
}

async function logHourlyMetrics(env: Bindings) {
  const now = new Date();
  
  const pendingCount = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM tasks WHERE status = 'PENDING'
  `).first() as CountRow | null;
  
  const processingCount = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM tasks WHERE status IN ('EXTRACTING', 'IMG2IMGING', 'COMPOSING')
  `).first() as CountRow | null;
  
  const completedCount = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM tasks WHERE status = 'COMPLETED' AND DATE(created_at) = DATE('now')
  `).first() as CountRow | null;

  await env.DB.prepare(`
    INSERT INTO metrics (metric_name, metric_value, timestamp) VALUES (?, ?, ?)
  `).bind('pending_tasks', pendingCount?.count || 0, now.toISOString()).run();

  await env.DB.prepare(`
    INSERT INTO metrics (metric_name, metric_value, timestamp) VALUES (?, ?, ?)
  `).bind('processing_tasks', processingCount?.count || 0, now.toISOString()).run();

  await env.DB.prepare(`
    INSERT INTO metrics (metric_name, metric_value, timestamp) VALUES (?, ?, ?)
  `).bind('daily_completed_tasks', completedCount?.count || 0, now.toISOString()).run();

  console.log('Logged hourly metrics');
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

async function checkAlertRules(env: Bindings) {
  const rulesResult = await env.DB.prepare(`
    SELECT * FROM alert_rules WHERE is_active = TRUE
  `).all();

  const rules = rulesResult.results as unknown as AlertRule[];

  for (const rule of rules) {
    const metric = await env.DB.prepare(`
      SELECT metric_value FROM metrics 
      WHERE metric_name = ? ORDER BY timestamp DESC LIMIT 1
    `).bind(rule.metric_name).first() as MetricRow | null;

    if (!metric) continue;

    const shouldAlert = evaluateCondition(parseFloat(metric.metric_value), rule.condition);

    if (shouldAlert) {
      const lastTriggeredStr = rule.last_triggered_at;
      const lastTriggered = lastTriggeredStr ? new Date(lastTriggeredStr) : null;
      const now = new Date();
      
      const cooldownSeconds = rule.cooldown_seconds ?? 3600;
      if (!lastTriggered || (now.getTime() - lastTriggered.getTime()) > cooldownSeconds * 1000) {
        await env.DB.prepare(`
          INSERT INTO alert_history (rule_id, message, severity) VALUES (?, ?, ?)
        `).bind(rule.id, rule.description || rule.name, rule.severity).run();

        await env.DB.prepare(`
          UPDATE alert_rules SET last_triggered_at = CURRENT_TIMESTAMP WHERE id = ?
        `).bind(rule.id).run();

        console.log(`Alert triggered: ${rule.name}`);
      }
    }
  }
}