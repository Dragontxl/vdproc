import { Hono } from 'hono';
import { taskRoutes } from './tasks';
import { accountRoutes } from './accounts';
import { configRoutes } from './config';
import { metricsRoutes } from './metrics';
import { fileRoutes } from './files';

const adminRoutes = new Hono();

adminRoutes.route('/tasks', taskRoutes);
adminRoutes.route('/accounts', accountRoutes);
adminRoutes.route('/config', configRoutes);
adminRoutes.route('/metrics', metricsRoutes);
adminRoutes.route('/files', fileRoutes);

export { adminRoutes };