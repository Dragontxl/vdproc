import { Hono } from 'hono';
import { Bindings } from '../../types/env';
import { SHOT_CONFIG_KEY } from '../../shotConfigKey';

// 前端「发送参数」点击后，把分镜生成参数写入 R2 对象，
// 各处运行中的 agnes-video-app 通过 GET 轮询即可同步。
const adminShotConfigRoutes = new Hono<{ Bindings: Bindings }>();

adminShotConfigRoutes.put('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ code: 400, data: null, msg: '请求体必须是 JSON' }, 400);
  }

  const record = body as {
    prompt?: unknown;
    keyframes?: unknown;
    num_frames?: unknown;
    frame_rate?: unknown;
  };

  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
  if (!prompt) {
    return c.json({ code: 400, data: null, msg: '缺少提示词 prompt' }, 400);
  }

  const keyframes = Array.isArray(record.keyframes)
    ? record.keyframes.filter((k): k is string => typeof k === 'string' && k.trim() !== '')
    : [];
  const numFrames = Number(record.num_frames) || 0;
  const frameRate = Number(record.frame_rate) || 24;

  const stored = {
    prompt,
    keyframes,
    num_frames: numFrames,
    frame_rate: frameRate,
    updated_at: new Date().toISOString(),
  };

  const object = await c.env.R2.put(SHOT_CONFIG_KEY, JSON.stringify(stored, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });

  return c.json({ code: 200, data: { ...stored, etag: object?.httpEtag }, msg: '已写入 R2 云配置' });
});

export { adminShotConfigRoutes };