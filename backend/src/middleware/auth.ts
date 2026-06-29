import { MiddlewareHandler } from 'hono';
import { jwtVerify } from 'jose';
import { Bindings } from '../types/env';

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader) {
    return c.json({ code: 401, data: null, msg: 'Unauthorized' }, 401);
  }
  
  const token = authHeader.replace('Bearer ', '');
  
  try {
    const encoder = new TextEncoder();
    const secret = encoder.encode((c.env as Bindings).JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    
    if (!payload || !payload.userId) {
      return c.json({ code: 401, data: null, msg: 'Invalid token' }, 401);
    }
    
    c.set('userId', payload.userId as string);
    c.set('role', (payload.role as string) || 'USER');
    
    await next();
  } catch {
    return c.json({ code: 401, data: null, msg: 'Invalid or expired token' }, 401);
  }
};