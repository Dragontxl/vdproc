import { Hono } from 'hono';
import { Bindings } from '../../types/env';
import { I2I_CONFIG_KEY } from '../../shotConfigKey';

// 目标 exe（agnes-video-app）的「图生图」页轮询该接口获取参数。
// 携带 If-None-Match 时，未变化返回 304。
const i2iConfigRoutes = new Hono<{ Bindings: Bindings }>();

i2iConfigRoutes.get('/', async (c) => {
  const object = await c.env.R2.get(I2I_CONFIG_KEY);
  if (!object) {
    return c.json({ code: 404, data: null, msg: 'not found' }, 404);
  }

  const etag = object.httpEtag;
  const ifNoneMatch = c.req.header('if-none-match');
  if (ifNoneMatch && ifNoneMatch.trim() === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const body = await object.text();
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ETag: etag,
      'Cache-Control': 'no-store',
    },
  });
});

export { i2iConfigRoutes };