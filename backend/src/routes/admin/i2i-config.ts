import { Hono } from 'hono';
import { Bindings } from '../../types/env';
import { I2I_CONFIG_KEY } from '../../shotConfigKey';

// 前端「首尾帧转化」子任务的「发送参数」点击后，把图生图参数写入 R2 对象。
const adminI2IConfigRoutes = new Hono<{ Bindings: Bindings }>();

adminI2IConfigRoutes.put('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ code: 400, data: null, msg: '请求体必须是 JSON' }, 400);
  }

  const record = body as {
    prompt?: unknown;
    keyframes?: unknown;
    width?: unknown;
    height?: unknown;
  };

  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
  if (!prompt) {
    return c.json({ code: 400, data: null, msg: '缺少提示词 prompt' }, 400);
  }

  const keyframes = Array.isArray(record.keyframes)
    ? record.keyframes.filter((k): k is string => typeof k === 'string' && k.trim() !== '')
    : [];
  if (keyframes.length === 0) {
    return c.json({ code: 400, data: null, msg: '缺少图片地址 keyframes' }, 400);
  }

  const stored = {
    prompt,
    keyframes,
    width: Number(record.width) || 1152,
    height: Number(record.height) || 864,
    updated_at: new Date().toISOString(),
  };

  const object = await c.env.R2.put(I2I_CONFIG_KEY, JSON.stringify(stored, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });

  return c.json({ code: 200, data: { ...stored, etag: object?.httpEtag }, msg: '已写入 R2 云配置' });
});

export { adminI2IConfigRoutes };