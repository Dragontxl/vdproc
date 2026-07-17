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

callbackRoutes.post('/subtask/create', async (c) => {
  const service = new TaskService(c.env as Bindings);
  const body = await c.req.json();
  
  await service.createPhaseSubtask(
    body.task_id,
    body.phase,
    body.subtask_index,
    body.subtask_type,
    body.input_path,
    body.metadata
  );
  
  return c.json({ code: 200, msg: 'Subtask created' });
});

callbackRoutes.post('/subtask/update', async (c) => {
  const service = new TaskService(c.env as Bindings);
  const body = await c.req.json();
  
  await service.updatePhaseSubtaskStatus(
    body.task_id,
    body.phase,
    body.subtask_index,
    body.status,
    body.output_path,
    body.error_msg
  );
  
  return c.json({ code: 200, msg: 'Subtask updated' });
});

export { callbackRoutes };