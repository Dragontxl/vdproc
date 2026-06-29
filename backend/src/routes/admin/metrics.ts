import { Hono } from 'hono';
import { MonitoringService } from '../../services/MonitoringService';
import { Bindings } from '../../types/env';

const metricsRoutes = new Hono();

metricsRoutes.get('/', async (c) => {
  const service = new MonitoringService(c.env as Bindings);
  const metrics = await service.collectSystemMetrics();
  
  return c.json({ code: 200, data: metrics, msg: 'success' });
});

metricsRoutes.get('/:name', async (c) => {
  const service = new MonitoringService(c.env as Bindings);
  const hoursStr = c.req.query('hours') as string || '24';
  const history = await service.getMetricHistory(c.req.param('name'), parseInt(hoursStr));
  
  return c.json({ code: 200, data: history, msg: 'success' });
});

metricsRoutes.get('/alerts/list', async (c) => {
  const service = new MonitoringService(c.env as Bindings);
  const alerts = await service.getAlertHistory();
  
  return c.json({ code: 200, data: alerts, msg: 'success' });
});

metricsRoutes.post('/alerts/check', async (c) => {
  const service = new MonitoringService(c.env as Bindings);
  const triggered = await service.checkAlerts();
  
  return c.json({ code: 200, data: triggered, msg: 'success' });
});

metricsRoutes.post('/alerts', async (c) => {
  const service = new MonitoringService(c.env as Bindings);
  const body = await c.req.json();
  
  await service.createAlertRule(
    body.name,
    body.description,
    body.metric_name,
    body.condition,
    body.severity
  );
  
  return c.json({ code: 201, data: null, msg: 'Alert rule created successfully' }, 201);
});

metricsRoutes.delete('/alerts/:id', async (c) => {
  const service = new MonitoringService(c.env as Bindings);
  await service.deleteAlertRule(parseInt(c.req.param('id')));
  
  return c.json({ code: 200, data: null, msg: 'Alert rule deleted successfully' });
});

export { metricsRoutes };