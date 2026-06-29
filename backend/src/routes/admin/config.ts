import { Hono } from 'hono';
import { ConfigService } from '../../services/ConfigService';
import { Bindings } from '../../types/env';

const configRoutes = new Hono();

configRoutes.get('/', async (c) => {
  const service = new ConfigService(c.env as Bindings);
  const configs = await service.getAllConfigs();
  
  return c.json({ code: 200, data: configs, msg: 'success' });
});

configRoutes.get('/:key', async (c) => {
  const service = new ConfigService(c.env as Bindings);
  const config = await service.getConfig(c.req.param('key'));
  
  if (!config) {
    return c.json({ code: 404, data: null, msg: 'Config not found' }, 404);
  }
  
  return c.json({ code: 200, data: config, msg: 'success' });
});

configRoutes.put('/:key', async (c) => {
  const service = new ConfigService(c.env as Bindings);
  const body = await c.req.json();
  
  const updated = await service.updateConfig(c.req.param('key'), body.value);
  
  if (!updated) {
    return c.json({ code: 404, data: null, msg: 'Config not found' }, 404);
  }
  
  return c.json({ code: 200, data: updated, msg: 'Config updated successfully' });
});

configRoutes.post('/', async (c) => {
  const service = new ConfigService(c.env as Bindings);
  const body = await c.req.json();
  
  const created = await service.createConfig(body.key, body.value, body.description);
  
  return c.json({ code: 201, data: created, msg: 'Config created successfully' }, 201);
});

configRoutes.delete('/:key', async (c) => {
  const service = new ConfigService(c.env as Bindings);
  const deleted = await service.deleteConfig(c.req.param('key'));
  
  if (!deleted) {
    return c.json({ code: 404, data: null, msg: 'Config not found' }, 404);
  }
  
  return c.json({ code: 200, data: null, msg: 'Config deleted successfully' });
});

export { configRoutes };