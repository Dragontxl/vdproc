import { MiddlewareHandler } from 'hono';

export const errorHandler: MiddlewareHandler = async (c, next) => {
  try {
    await next();
  } catch (error) {
    console.error('Error:', error);
    
    const status = error instanceof Error ? 500 : (error as any).status || 500;
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    
    return c.json({
      code: status,
      data: null,
      msg: message,
    }, status);
  }
};