import { Hono } from 'hono';
import { CryptoService } from '../../services/CryptoService';
import { Bindings } from '../../types/env';

const authRoutes = new Hono();

authRoutes.post('/login', async (c) => {
  const body = await c.req.json();
  const { username, password } = body;

  if (!username || !password) {
    return c.json({ code: 400, data: null, msg: 'Missing username or password' }, 400);
  }

  const result = await (c.env as Bindings).DB.prepare(`
    SELECT id, username, password_hash, role 
    FROM users 
    WHERE username = ? AND is_active = TRUE
  `).bind(username).first();

  if (!result) {
    return c.json({ code: 401, data: null, msg: 'Invalid credentials' }, 401);
  }

  const user = result as { id: number; username: string; password_hash: string; role: string };
  const cryptoService = new CryptoService(c.env as Bindings);

  const isPasswordValid = cryptoService.verifyPassword(password, user.password_hash);

  if (!isPasswordValid) {
    return c.json({ code: 401, data: null, msg: 'Invalid credentials' }, 401);
  }

  const token = await cryptoService.generateToken(String(user.id), user.role);

  await (c.env as Bindings).DB.prepare(`
    UPDATE users 
    SET last_login_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `).bind(user.id).run();

  return c.json({
    code: 200,
    data: {
      token,
      userId: user.id,
      username: user.username,
      role: user.role,
    },
    msg: 'Login successful',
  });
});

authRoutes.post('/refresh', async (c) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader) {
    return c.json({ code: 401, data: null, msg: 'Unauthorized' }, 401);
  }

  const token = authHeader.replace('Bearer ', '');
  const cryptoService = new CryptoService(c.env as Bindings);
  
  const decoded = await cryptoService.verifyToken(token);
  
  if (!decoded) {
    return c.json({ code: 401, data: null, msg: 'Invalid token' }, 401);
  }

  const newToken = await cryptoService.generateToken(decoded.userId, decoded.role);

  return c.json({
    code: 200,
    data: { token: newToken },
    msg: 'Token refreshed',
  });
});

export { authRoutes };