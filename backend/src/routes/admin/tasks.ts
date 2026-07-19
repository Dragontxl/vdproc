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
  const body = await c.req.json().catch(() => ({}));
  const { start_phase, end_phase } = body;
  
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
  
  const result = await taskService.triggerPhase(id, phase as TaskPhase, undefined, undefined, start_phase as TaskPhase, end_phase as TaskPhase);
  
  const msg = start_phase && end_phase 
    ? `${start_phase}到${end_phase}阶段启动成功` 
    : `${phase}阶段启动成功`;
  
  return c.json({
    code: 200,
    msg,
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

taskRoutes.get('/:id/subtasks', async (c) => {
  const { id } = c.req.param();
  const phase = c.req.query('phase') as string;
  
  const taskService = new TaskService(c.env as Bindings);
  const subtasks = await taskService.getPhaseSubtasks(id, phase);
  
  return c.json({
    code: 200,
    data: subtasks,
    msg: 'success',
  });
});

taskRoutes.post('/:id/subtasks/:phase/:index/run', async (c) => {
  const { id, phase, index } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const { custom_prompt } = body;
  
  const taskService = new TaskService(c.env as Bindings);
  
  try {
    const result = await taskService.runSubtask(id, phase, parseInt(index), custom_prompt);
    return c.json({
      code: 200,
      data: result,
      msg: '子任务启动成功',
    });
  } catch (error) {
    return c.json({
      code: 500,
      data: null,
      msg: (error as Error).message,
    }, 500);
  }
});

taskRoutes.post('/:id/subtasks', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const { phase, subtask_index, subtask_type, input_path, metadata } = body;
  
  const taskService = new TaskService(c.env as Bindings);
  
  try {
    await taskService.createPhaseSubtask(id, phase, subtask_index, subtask_type, input_path, metadata);
    return c.json({
      code: 201,
      data: null,
      msg: '子任务创建成功',
    }, 201);
  } catch (error) {
    return c.json({
      code: 500,
      data: null,
      msg: (error as Error).message,
    }, 500);
  }
});

export { taskRoutes };