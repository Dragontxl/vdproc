import { Hono } from 'hono';
import { TaskService } from '../../services/TaskService';
import { Bindings } from '../../types/env';

const callbackRoutes = new Hono();

callbackRoutes.post('/github', async (c) => {
  const service = new TaskService(c.env as Bindings);
  const body = await c.req.json();
  
  const result = await service.handleGitHubCallback(body);
  
  return c.json({ code: 200, data: result, msg: 'Callback processed' });
});

callbackRoutes.post('/progress', async (c) => {
  const service = new TaskService(c.env as Bindings);
  const body = await c.req.json();
  
  const result = await service.updateTaskProgress(body);
  
  return c.json({ code: 200, data: result, msg: 'Progress updated' });
});

callbackRoutes.post('/complete', async (c) => {
  const service = new TaskService(c.env as Bindings);
  const body = await c.req.json();
  
  const result = await service.handleTaskComplete(body);
  
  return c.json({ code: 200, data: result, msg: 'Task completed' });
});

callbackRoutes.post('/error', async (c) => {
  const service = new TaskService(c.env as Bindings);
  const body = await c.req.json();
  
  const result = await service.handleTaskError(body);
  
  return c.json({ code: 200, data: result, msg: 'Error handled' });
});

callbackRoutes.post('/account-error', async (c) => {
  const service = new TaskService(c.env as Bindings);
  const body = await c.req.json();
  
  const result = await service.handleAccountError(body);
  
  return c.json({ code: 200, data: result, msg: 'Account error handled' });
});

export { callbackRoutes };