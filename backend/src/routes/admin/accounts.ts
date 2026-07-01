import { Hono } from 'hono';
import { AccountService } from '../../services/AccountService';
import { Bindings } from '../../types/env';

const accountRoutes = new Hono();

accountRoutes.get('/github', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const accounts = await service.listGitHubAccounts();
  
  return c.json({ code: 200, data: accounts, msg: 'success' });
});

accountRoutes.post('/github', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const body = await c.req.json();
  
  if (body.token_encrypted) {
    const CryptoService = (await import('../../services/CryptoService')).CryptoService;
    const cryptoService = new CryptoService(c.env as Bindings);
    body.token_encrypted = await cryptoService.encrypt(body.token_encrypted);
  }
  
  const account = await service.createGitHubAccount(body);
  
  return c.json({ code: 201, data: account, msg: 'Account created successfully' }, 201);
});

accountRoutes.put('/github/:id', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const body = await c.req.json();
  
  if (body.token_encrypted) {
    const CryptoService = (await import('../../services/CryptoService')).CryptoService;
    const cryptoService = new CryptoService(c.env as Bindings);
    body.token_encrypted = await cryptoService.encrypt(body.token_encrypted);
  }
  
  const updated = await service.updateGitHubAccount(parseInt(c.req.param('id')), body);
  
  if (!updated) {
    return c.json({ code: 404, data: null, msg: 'Account not found' }, 404);
  }
  
  return c.json({ code: 200, data: updated, msg: 'Account updated successfully' });
});

accountRoutes.delete('/github/:id', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const deleted = await service.deleteGitHubAccount(parseInt(c.req.param('id')));
  
  if (!deleted) {
    return c.json({ code: 404, data: null, msg: 'Account not found' }, 404);
  }
  
  return c.json({ code: 200, data: null, msg: 'Account deleted successfully' });
});

accountRoutes.get('/ai', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const accounts = await service.listAIAccounts();
  
  return c.json({ code: 200, data: accounts, msg: 'success' });
});

accountRoutes.post('/ai', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const body = await c.req.json();
  
  if (body.api_key_encrypted) {
    const CryptoService = (await import('../../services/CryptoService')).CryptoService;
    const cryptoService = new CryptoService(c.env as Bindings);
    body.api_key_encrypted = await cryptoService.encrypt(body.api_key_encrypted);
  }
  
  const account = await service.createAIAccount(body);
  
  return c.json({ code: 201, data: account, msg: 'Account created successfully' }, 201);
});

accountRoutes.put('/ai/:id', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const body = await c.req.json();
  
  if (body.api_key_encrypted) {
    const CryptoService = (await import('../../services/CryptoService')).CryptoService;
    const cryptoService = new CryptoService(c.env as Bindings);
    body.api_key_encrypted = await cryptoService.encrypt(body.api_key_encrypted);
  }
  
  const updated = await service.updateAIAccount(parseInt(c.req.param('id')), body);
  
  if (!updated) {
    return c.json({ code: 404, data: null, msg: 'Account not found' }, 404);
  }
  
  return c.json({ code: 200, data: updated, msg: 'Account updated successfully' });
});

accountRoutes.delete('/ai/:id', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const deleted = await service.deleteAIAccount(parseInt(c.req.param('id')));
  
  if (!deleted) {
    return c.json({ code: 404, data: null, msg: 'Account not found' }, 404);
  }
  
  return c.json({ code: 200, data: null, msg: 'Account deleted successfully' });
});

accountRoutes.post('/ai/:id/health', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const result = await service.checkAIAccountHealth(parseInt(c.req.param('id')));
  
  return c.json({ code: 200, data: result, msg: 'Health check completed' });
});

export { accountRoutes };