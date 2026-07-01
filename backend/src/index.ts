import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { prettyJSON } from 'hono/pretty-json';
import { taskRoutes } from './routes/public/tasks';
import { callbackRoutes } from './routes/public/callback';
import { authRoutes } from './routes/public/auth';
import { adminRoutes } from './routes/admin';
import { authMiddleware } from './middleware/auth';
import { loggerMiddleware } from './middleware/logger';
import { errorHandler } from './middleware/error';
import { scheduled } from './scheduled';
import { Bindings } from './types/env';

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors({
  origin: (origin) => {
    const allowedOrigins = [
      'http://localhost:3000',
      'https://ai-video.ldragon.xyz',
      'https://ai-video-admin.ldragon.xyz',
      'https://b4272ef7.ai-video-frontend-c9p.pages.dev',
      'https://main.ai-video-frontend-c9p.pages.dev',
    ];
    if (allowedOrigins.includes(origin)) {
      return origin;
    }
    return null;
  },
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Callback-Signature'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
}));

app.use('*', prettyJSON());
app.use('*', loggerMiddleware);
app.use('*', errorHandler);

app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: c.env.ENVIRONMENT,
  });
});

app.route('/api/v1/tasks', taskRoutes);
app.route('/api/v1/callback', callbackRoutes);
app.route('/api/v1/auth', authRoutes);
app.use('/api/admin/*', authMiddleware);
app.route('/api/admin', adminRoutes);

app.notFound((c) => {
  return c.json({ code: 404, msg: 'Not Found' }, 404);
});

export default app;

export { scheduled };