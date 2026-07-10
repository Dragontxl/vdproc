import { Hono } from 'hono';
import { TaskService } from '../../services/TaskService';
import { Bindings } from '../../types/env';

const taskRoutes = new Hono();

taskRoutes.get('/', async (c) => {
  const service = new TaskService(c.env as Bindings);
  const query = c.req.query();
  const status = query.status as string;
  const page = parseInt(query.page as string || '1');
  const limit = parseInt(query.limit as string || '20');
  
  const tasks = await service.listTasks({ status, page, limit });
  
  return c.json({ code: 200, data: tasks, msg: 'success' });
});

taskRoutes.get('/:id', async (c) => {
  const service = new TaskService(c.env as Bindings);
  const task = await service.getTask(c.req.param('id'));
  
  if (!task) {
    return c.json({ code: 404, data: null, msg: 'Task not found' }, 404);
  }
  
  return c.json({ code: 200, data: task, msg: 'success' });
});

taskRoutes.post('/', async (c) => {
  const service = new TaskService(c.env as Bindings);
  
  try {
    const body = await c.req.json();
    
    const task = await service.createTask({
      title: body.title,
      videoPath: body.video_path,
      fps: body.fps || 30,
      prompt: body.prompt || '',
      outputFps: body.output_fps || 30,
      priority: body.priority || 0,
      tags: body.tags || '',
    });
    
    try {
      await service.startTask(task.id);
      return c.json({ code: 201, data: task, msg: 'Task created successfully' }, 201);
    } catch (error) {
      console.error('Failed to start task:', error);
      return c.json({ code: 201, data: task, msg: 'Task created but failed to start: ' + (error as Error).message }, 201);
    }
  } catch (error) {
    console.error('Failed to create task:', error);
    return c.json({ code: 500, data: null, msg: 'Failed to create task: ' + (error as Error).message }, 500);
  }
});

taskRoutes.put('/:id', async (c) => {
  const service = new TaskService(c.env as Bindings);
  const body = await c.req.json();
  
  const updated = await service.updateTask(c.req.param('id'), body);
  
  if (!updated) {
    return c.json({ code: 404, data: null, msg: 'Task not found' }, 404);
  }
  
  return c.json({ code: 200, data: updated, msg: 'Task updated successfully' });
});

taskRoutes.delete('/:id', async (c) => {
  const service = new TaskService(c.env as Bindings);
  const deleted = await service.deleteTask(c.req.param('id'));
  
  if (!deleted) {
    return c.json({ code: 404, data: null, msg: 'Task not found' }, 404);
  }
  
  return c.json({ code: 200, data: null, msg: 'Task deleted successfully' });
});

taskRoutes.post('/:id/start', async (c) => {
  const service = new TaskService(c.env as Bindings);
  try {
    const result = await service.startTask(c.req.param('id'));
    
    if (!result) {
      return c.json({ code: 400, data: null, msg: 'Failed to start task' }, 400);
    }
    
    return c.json({ code: 200, data: result, msg: 'Task started successfully' });
  } catch (error) {
    console.error('Failed to start task:', error);
    return c.json({ code: 500, data: null, msg: 'Failed to start task: ' + (error as Error).message }, 500);
  }
});

taskRoutes.post('/:id/cancel', async (c) => {
  const service = new TaskService(c.env as Bindings);
  const cancelled = await service.cancelTask(c.req.param('id'));
  
  if (!cancelled) {
    return c.json({ code: 404, data: null, msg: 'Task not found' }, 404);
  }
  
  return c.json({ code: 200, data: cancelled, msg: 'Task cancelled successfully' });
});

taskRoutes.post('/:id/retry', async (c) => {
  const service = new TaskService(c.env as Bindings);
  const result = await service.retryFailedTask(c.req.param('id'));
  
  if (!result) {
    return c.json({ code: 400, data: null, msg: 'Failed to retry task' }, 400);
  }
  
  return c.json({ code: 200, data: result, msg: 'Task retry scheduled' });
});

taskRoutes.post('/:id/restart-phase', async (c) => {
  const service = new TaskService(c.env as Bindings);
  const task = await service.getTask(c.req.param('id'));
  
  if (!task) {
    return c.json({ code: 404, data: null, msg: 'Task not found' }, 404);
  }
  
  const currentPhase = task.current_phase;
  if (!currentPhase) {
    return c.json({ code: 400, data: null, msg: 'No active phase to restart' }, 400);
  }
  
  try {
    await service.triggerPhase(c.req.param('id'), currentPhase as any);
    const updatedTask = await service.getTask(c.req.param('id'));
    return c.json({ code: 200, data: updatedTask, msg: `Phase ${currentPhase} restarted` });
  } catch (error) {
    console.error('Failed to restart phase:', error);
    return c.json({ code: 500, data: null, msg: (error as Error).message }, 500);
  }
});

taskRoutes.post('/:id/advance', async (c) => {
  const service = new TaskService(c.env as Bindings);
  await service.advancePhase(c.req.param('id'));
  
  const task = await service.getTask(c.req.param('id'));
  return c.json({ code: 200, data: task, msg: 'Phase advanced' });
});

export { taskRoutes };