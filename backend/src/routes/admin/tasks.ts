import { Hono } from 'hono';
import { TaskService } from '../../services/TaskService';
import { MaterialCheckService } from '../../services/MaterialCheckService';
import { Bindings } from '../../types/env';
import { TaskPhase } from '../../types';

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

taskRoutes.get('/:id/check-phase/:phase', async (c) => {
  const { id, phase } = c.req.param();
  const taskService = new TaskService(c.env as Bindings);
  const materialService = new MaterialCheckService(c.env as Bindings);
  
  const task = await taskService.getTask(id);
  const videoPath = task?.video_path;
  
  const result = await materialService.checkPhaseRequirements(id, phase as TaskPhase, videoPath);
  
  return c.json({
    code: 200,
    data: result,
    msg: result.ready ? '素材齐全' : '素材不全',
  });
});

taskRoutes.post('/:id/start-phase/:phase', async (c) => {
  const { id, phase } = c.req.param();
  const taskService = new TaskService(c.env as Bindings);
  const materialService = new MaterialCheckService(c.env as Bindings);
  
  const task = await taskService.getTask(id);
  if (!task) {
    return c.json({ code: 404, data: null, msg: '任务不存在' }, 404);
  }
  
  const checkResult = await materialService.checkPhaseRequirements(id, phase as TaskPhase, task.video_path);
  
  if (!checkResult.ready) {
    return c.json({
      code: 400,
      msg: '素材不全，无法启动该阶段',
      data: {
        missing: checkResult.missing,
        available: checkResult.available,
      },
    }, 400);
  }
  
  const result = await taskService.startPhase(id, phase as TaskPhase);
  
  return c.json({
    code: 200,
    msg: `${phase}阶段启动成功`,
    data: result,
  });
});

taskRoutes.get('/phase-order', async (c) => {
  const taskService = new TaskService(c.env as Bindings);
  const phaseOrder = taskService.getPhaseOrder();
  
  return c.json({
    code: 200,
    data: phaseOrder,
    msg: 'success',
  });
});

export { taskRoutes };