import { Hono } from 'hono';
import { TaskService } from '../../services/TaskService';
import { Bindings } from '../../types/env';

const taskRoutes = new Hono();

taskRoutes.get('/', async (c) => {
  const service = new TaskService(c.env as Bindings);
  const query = c.req.query();
  const status = query.status as string;
  const page = parseInt(query.page as string || '1');
  const limit = parseInt(query.limit as string || '50');
  
  const tasks = await service.listTasks({ status, page, limit });
  
  return c.json({ code: 200, data: tasks, msg: 'success' });
});

taskRoutes.get('/:id/logs', async (c) => {
  const service = new TaskService(c.env as Bindings);
  const logs = await service.getTaskLogs(c.req.param('id'));
  
  return c.json({ code: 200, data: logs, msg: 'success' });
});

taskRoutes.post('/batch', async (c) => {
  const service = new TaskService(c.env as Bindings);
  const body = await c.req.json();
  
  const results = await service.batchCreateTasks(body.tasks);
  
  return c.json({ code: 201, data: results, msg: 'Batch created successfully' }, 201);
});

taskRoutes.delete('/:id', async (c) => {
  const service = new TaskService(c.env as Bindings);
  const deleted = await service.deleteTask(c.req.param('id'));
  
  if (!deleted) {
    return c.json({ code: 404, data: null, msg: 'Task not found' }, 404);
  }
  
  return c.json({ code: 200, data: null, msg: 'Task deleted successfully' });
});

export { taskRoutes };