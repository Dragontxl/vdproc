import { Hono } from 'hono';
import { AccountService } from '../../services/AccountService';
import { CryptoService } from '../../services/CryptoService';
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
  
  const account = await service.createGitHubAccount(body);
  
  return c.json({ code: 201, data: account, msg: 'Account created successfully' }, 201);
});

accountRoutes.put('/github/:id', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const body = await c.req.json();
  
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
  try {
    const service = new AccountService(c.env as Bindings);
    const body = await c.req.json();
    
    const account = await service.createAIAccount(body);
    
    return c.json({ code: 201, data: account, msg: 'Account created successfully' }, 201);
  } catch (error) {
    console.error('Create AI account error:', error);
    return c.json({ code: 500, data: null, msg: 'Failed to create account: ' + (error as Error).message }, 500);
  }
});

accountRoutes.put('/ai/:id', async (c) => {
  const service = new AccountService(c.env as Bindings);
  const body = await c.req.json();
  
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

accountRoutes.get('/ai/:id/debug', async (c) => {
  const cryptoService = new CryptoService(c.env as Bindings);
  const result = await c.env.DB.prepare('SELECT id, api_key_encrypted, base_url FROM ai_accounts WHERE id = ?')
    .bind(parseInt(c.req.param('id'))).first();

  if (!result) {
    return c.json({ code: 404, data: null, msg: 'Not found' }, 404);
  }

  const storedKey = (result as any).api_key_encrypted;
  let decryptedKey = '';
  let decryptError = '';

  try {
    decryptedKey = await cryptoService.decrypt(storedKey);
  } catch (e) {
    decryptError = (e as Error).message;
  }

  const testEncrypt = await cryptoService.encrypt('test-key-123');
  let testDecrypt = '';
  let testDecryptError = '';
  try {
    testDecrypt = await cryptoService.decrypt(testEncrypt);
  } catch (e) {
    testDecryptError = (e as Error).message;
  }

  return c.json({
    code: 200,
    data: {
      id: (result as any).id,
      storedKeyLength: storedKey?.length,
      storedKeyPrefix: storedKey?.substring(0, 10),
      decryptedKeyLength: decryptedKey.length,
      decryptedKeyPrefix: decryptedKey.substring(0, 4),
      decryptError,
      testEncryptLength: testEncrypt.length,
      testDecryptResult: testDecrypt,
      testDecryptError,
    },
    msg: 'Debug info'
  });
});

export { accountRoutes };