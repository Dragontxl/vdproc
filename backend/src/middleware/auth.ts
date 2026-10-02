import { MiddlewareHandler } from 'hono';
import { jwtVerify } from 'jose';
import { Bindings } from '../types/env';

function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

export const callbackAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const secret = (c.env as Bindings).CALLBACK_SECRET;
  const provided = c.req.header('X-Callback-Signature') || '';

  if (!secret) {
    console.error('callbackAuthMiddleware: CALLBACK_SECRET not configured, rejecting callback');
    return c.json({ code: 401, data: null, msg: 'Callback auth not configured' }, 401);
  }

  if (!provided || !timingSafeEqual(provided, secret)) {
    console.error('callbackAuthMiddleware: invalid callback signature rejected');
    return c.json({ code: 401, data: null, msg: 'Invalid callback signature' }, 401);
  }

  await next();
};

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