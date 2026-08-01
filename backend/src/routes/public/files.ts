import { Hono } from 'hono';
import { Bindings } from '../../types/env';

const publicFileRoutes = new Hono();

publicFileRoutes.get('/version/:filename', async (c) => {
  const { R2 } = c.env as Bindings;
  const filename = decodeURIComponent(c.req.param('filename'));
  const prefix = c.req.query('prefix') || '';
  
  const key = prefix ? `${prefix.replace(/\/$/, '')}/${filename}` : filename;

  try {
    const object = await R2.get(key);
    
    if (!object) {
      return c.json({
        code: 404,
        data: null,
        msg: '文件不存在',
      }, 404);
    }

    const md = object.httpMetadata as any;
    const lastModified = md?.lastModified 
      ? new Date(md.lastModified).toISOString() 
      : new Date().toISOString();
    
    const etag = md?.etag || `"${lastModified}-${object.size}"`;
    
    return c.json({
      code: 200,
      data: {
        key,
        etag,
        lastModified,
        size: object.size,
      },
      msg: 'success',
    });
  } catch (error) {
    console.error('R2 version check error:', error);
    return c.json({
      code: 500,
      data: null,
      msg: '获取文件版本失败',
    }, 500);
  }
});

publicFileRoutes.get('/preview/:filename', async (c) => {
  const { R2, R2_PUBLIC_URL } = c.env as Bindings;
  const filename = decodeURIComponent(c.req.param('filename'));
  const prefix = c.req.query('prefix') || '';
  
  const key = prefix ? `${prefix}${filename}` : filename;

  const noCache = c.req.query('no_cache');
  console.log('Preview request:', { filename, prefix, key, hasR2PublicUrl: !!R2_PUBLIC_URL, noCache });

  if (R2_PUBLIC_URL && !noCache) {
    const publicUrl = `${R2_PUBLIC_URL}/${key}`;
    console.log('Redirecting to R2 public URL:', publicUrl);
    return c.redirect(publicUrl, 302);
  }

  try {
    const object = await R2.get(key);
    
    if (!object) {
      console.log('File not found in R2:', key);
      return c.json({
        code: 404,
        data: null,
        msg: `文件不存在: ${key}`,
      }, 404);
    }
    
    console.log('File found:', { key, size: object.size, contentType: object.httpMetadata?.contentType });

    const headers = new Headers();
    
    const ext = filename.toLowerCase().split('.').pop();
    const contentTypes: Record<string, string> = {
      'mp4': 'video/mp4',
      'avi': 'video/x-msvideo',
      'mov': 'video/quicktime',
      'mkv': 'video/x-matroska',
      'webm': 'video/webm',
      'flv': 'video/x-flv',
      'wmv': 'video/x-ms-wmv',
    };
    
    const contentType = contentTypes[ext || ''] || object.httpMetadata?.contentType || 'application/octet-stream';
    headers.set('Content-Type', contentType);
    
    const contentLength = object.size;
    const range = c.req.header('Range');
    
    headers.set('Accept-Ranges', 'bytes');
    
    if (noCache) {
      headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      headers.set('Pragma', 'no-cache');
      headers.set('Expires', '0');
    } else {
      headers.set('Cache-Control', 'public, max-age=3600');
    }
    
    if ((object.httpMetadata as any)?.etag) {
      headers.set('ETag', (object.httpMetadata as any).etag);
    }
    
    if ((object.httpMetadata as any)?.lastModified) {
      headers.set('Last-Modified', new Date((object.httpMetadata as any).lastModified).toUTCString());
    }
    
    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : contentLength - 1;
        
        if (start >= contentLength) {
          return new Response(null, {
            status: 416,
            headers: {
              'Content-Range': `bytes */${contentLength}`,
            },
          });
        }
        
        const chunkSize = end - start + 1;
        const arrayBuffer = await object.arrayBuffer();
        const chunk = arrayBuffer.slice(start, end + 1);
        
        headers.set('Content-Range', `bytes ${start}-${end}/${contentLength}`);
        headers.set('Content-Length', chunkSize.toString());
        
        return new Response(chunk, {
          status: 206,
          headers,
        });
      }
    }
    
    headers.set('Content-Length', contentLength.toString());
    
    return new Response(object.body, {
      headers,
    });
  } catch (error) {
    console.error('R2 preview error:', error);
    return c.json({
      code: 500,
      data: null,
      msg: '预览文件失败',
    }, 500);
  }
});

publicFileRoutes.post('/purge', async (c) => {
  const { R2_PUBLIC_URL, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID } = c.env as Bindings;

  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({
      code: 401,
      data: null,
      msg: 'Unauthorized',
    }, 401);
  }

  const apiKey = authHeader.slice(7);
  const { ADMIN_API_KEY } = c.env as Bindings;
  if (apiKey !== ADMIN_API_KEY) {
    return c.json({
      code: 403,
      data: null,
      msg: 'Forbidden',
    }, 403);
  }

  try {
    const body = await c.req.json();
    const { keys } = body;

    if (!keys || !Array.isArray(keys) || keys.length === 0) {
      return c.json({
        code: 400,
        data: null,
        msg: 'Missing or invalid keys parameter',
      }, 400);
    }

    if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ZONE_ID || !R2_PUBLIC_URL) {
      return c.json({
        code: 500,
        data: null,
        msg: 'Cloudflare purge configuration not set',
      }, 500);
    }

    const purgeUrls = keys.map(key => {
      if (key.startsWith('http')) {
        return key;
      }
      return `${R2_PUBLIC_URL}/${key}`;
    });

    console.log('Purging Cloudflare cache for URLs:', purgeUrls);

    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: purgeUrls,
      }),
    });

    const result = await response.json() as any;

    if (result.success) {
      console.log('Cloudflare cache purge successful:', result);
      return c.json({
        code: 200,
        data: {
          purgedUrls: purgeUrls,
          result,
        },
        msg: 'Cache purge successful',
      });
    } else {
      console.error('Cloudflare cache purge failed:', result);
      return c.json({
        code: 500,
        data: null,
        msg: `Cache purge failed: ${result.errors?.map((e: any) => e.message).join(', ')}`,
      }, 500);
    }
  } catch (error) {
    console.error('Cloudflare cache purge error:', error);
    return c.json({
      code: 500,
      data: null,
      msg: 'Cache purge error',
    }, 500);
  }
});

publicFileRoutes.get('/nocache/*', async (c) => {
  const { R2 } = c.env as Bindings;
  const key = decodeURIComponent(c.req.param('*') || '');

  console.log('No-cache file request:', { key });

  try {
    const object = await R2.get(key);
    
    if (!object) {
      console.log('File not found in R2:', key);
      return c.json({
        code: 404,
        data: null,
        msg: `文件不存在: ${key}`,
      }, 404);
    }
    
    console.log('File found:', { key, size: object.size, contentType: object.httpMetadata?.contentType });

    const headers = new Headers();
    
    const filename = key.split('/').pop() || '';
    const ext = filename.toLowerCase().split('.').pop();
    const contentTypes: Record<string, string> = {
      'mp4': 'video/mp4',
      'avi': 'video/x-msvideo',
      'mov': 'video/quicktime',
      'mkv': 'video/x-matroska',
      'webm': 'video/webm',
      'flv': 'video/x-flv',
      'wmv': 'video/x-ms-wmv',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
    };
    
    const contentType = contentTypes[ext || ''] || object.httpMetadata?.contentType || 'application/octet-stream';
    headers.set('Content-Type', contentType);
    
    headers.set('Content-Length', object.size.toString());
    headers.set('Accept-Ranges', 'bytes');
    
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    headers.set('Pragma', 'no-cache');
    headers.set('Expires', '0');
    
    if ((object.httpMetadata as any)?.etag) {
      headers.set('ETag', (object.httpMetadata as any).etag);
    }
    
    if ((object.httpMetadata as any)?.lastModified) {
      headers.set('Last-Modified', new Date((object.httpMetadata as any).lastModified).toUTCString());
    }
    
    return new Response(object.body, {
      headers,
    });
  } catch (error) {
    console.error('R2 no-cache error:', error);
    return c.json({
      code: 500,
      data: null,
      msg: '获取文件失败',
    }, 500);
  }
});

export { publicFileRoutes };