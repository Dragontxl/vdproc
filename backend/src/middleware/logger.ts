import { MiddlewareHandler } from 'hono';

export const loggerMiddleware: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  
  await next();
  
  const end = Date.now();
  const duration = end - start;
  
  console.log({
    timestamp: new Date().toISOString(),
    method: c.req.method,
    url: c.req.url,
    status: c.res.status,
    duration: `${duration}ms`,
    ip: c.req.header('X-Forwarded-For') || c.req.header('Remote-Addr'),
  });
};