import { Hono } from 'hono';
import { Bindings } from '../../types/env';

const fileRoutes = new Hono();

fileRoutes.get('/', async (c) => {
  const { R2 } = c.env as Bindings;
  const prefix = c.req.query('prefix') || '';
  const delimiter = c.req.query('delimiter') || '/';

  try {
    const objects = await R2.list({
      prefix,
      delimiter,
      limit: 1000,
    });

    const files: {
      name: string;
      key: string;
      size: number;
      type: 'file' | 'directory';
      lastModified: string;
      contentType?: string;
    }[] = [];

    if (objects.delimitedPrefixes) {
      for (const prefix of objects.delimitedPrefixes) {
        files.push({
          name: prefix.replace(/\/$/, '').split('/').pop() || prefix,
          key: prefix,
          size: 0,
          type: 'directory',
          lastModified: '',
        });
      }
    }

    if (objects.objects) {
      for (const obj of objects.objects) {
        files.push({
          name: obj.key.split('/').pop() || obj.key,
          key: obj.key,
          size: obj.size,
          type: 'file',
          lastModified: obj.uploaded.toISOString(),
          contentType: obj.httpMetadata?.contentType,
        });
      }
    }

    files.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return c.json({
      code: 200,
      data: {
        files,
        prefix,
        isTruncated: objects.truncated,
      },
      msg: 'success',
    });
  } catch (error) {
    console.error('R2 list error:', error);
    return c.json({
      code: 500,
      data: null,
      msg: '获取文件列表失败',
    }, 500);
  }
});

fileRoutes.get('/download/:filename', async (c) => {
  const { R2 } = c.env as Bindings;
  const filename = c.req.param('filename');
  const prefix = c.req.query('prefix') || '';
  
  const key = prefix ? `${prefix}${filename}` : filename;

  try {
    const object = await R2.get(key);
    
    if (!object) {
      return c.json({
        code: 404,
        data: null,
        msg: '文件不存在',
      }, 404);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);

    return new Response(object.body, {
      headers,
    });
  } catch (error) {
    console.error('R2 download error:', error);
    return c.json({
      code: 500,
      data: null,
      msg: '下载文件失败',
    }, 500);
  }
});

fileRoutes.delete('/:filename', async (c) => {
  const { R2 } = c.env as Bindings;
  const filename = c.req.param('filename');
  const prefix = c.req.query('prefix') || '';
  
  const key = prefix ? `${prefix}${filename}` : filename;

  try {
    await R2.delete(key);
    
    return c.json({
      code: 200,
      data: null,
      msg: '文件删除成功',
    });
  } catch (error) {
    console.error('R2 delete error:', error);
    return c.json({
      code: 500,
      data: null,
      msg: '删除文件失败',
    }, 500);
  }
});

fileRoutes.post('/batch-delete', async (c) => {
  const { R2 } = c.env as Bindings;
  
  try {
    const body = await c.req.json().catch(() => ({}));
    const { keys } = body;
    
    if (!Array.isArray(keys) || keys.length === 0) {
      return c.json({
        code: 400,
        data: null,
        msg: '请提供要删除的文件列表',
      }, 400);
    }

    const errors: string[] = [];
    
    for (const key of keys) {
      try {
        await R2.delete(key);
      } catch (error) {
        errors.push(key);
      }
    }

    if (errors.length === 0) {
      return c.json({
        code: 200,
        data: null,
        msg: '批量删除成功',
      });
    } else {
      return c.json({
        code: 200,
        data: {
          deleted: keys.length - errors.length,
          failed: errors.length,
          failedKeys: errors,
        },
        msg: `部分删除成功，${errors.length} 个文件删除失败`,
      });
    }
  } catch (error) {
    console.error('R2 batch delete error:', error);
    return c.json({
      code: 500,
      data: null,
      msg: '批量删除失败',
    }, 500);
  }
});

fileRoutes.post('/upload', async (c) => {
  const { R2 } = c.env as Bindings;
  
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    const prefix = (formData.get('prefix') as string) || '';
    
    if (!file) {
      return c.json({
        code: 400,
        data: null,
        msg: '请选择要上传的文件',
      }, 400);
    }

    const key = prefix ? `${prefix}${file.name}` : file.name;
    
    const arrayBuffer = await file.arrayBuffer();
    
    await R2.put(key, arrayBuffer, {
      httpMetadata: {
        contentType: file.type || 'application/octet-stream',
      },
    });

    return c.json({
      code: 200,
      data: {
        key,
        name: file.name,
        size: file.size,
        contentType: file.type,
      },
      msg: '文件上传成功',
    });
  } catch (error) {
    console.error('R2 upload error:', error);
    return c.json({
      code: 500,
      data: null,
      msg: '上传文件失败',
    }, 500);
  }
});

fileRoutes.post('/batch-upload', async (c) => {
  const { R2 } = c.env as Bindings;
  
  try {
    const formData = await c.req.formData();
    const files = formData.getAll('files') as File[];
    const prefix = (formData.get('prefix') as string) || '';
    
    if (files.length === 0) {
      return c.json({
        code: 400,
        data: null,
        msg: '请选择要上传的文件',
      }, 400);
    }

    const results: {
      key: string;
      name: string;
      size: number;
      success: boolean;
      error?: string;
    }[] = [];

    for (const file of files) {
      try {
        const key = prefix ? `${prefix}${file.name}` : file.name;
        const arrayBuffer = await file.arrayBuffer();
        
        await R2.put(key, arrayBuffer, {
          httpMetadata: {
            contentType: file.type || 'application/octet-stream',
          },
        });
        
        results.push({
          key,
          name: file.name,
          size: file.size,
          success: true,
        });
      } catch (error) {
        results.push({
          key: '',
          name: file.name,
          size: file.size,
          success: false,
          error: (error as Error).message,
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    
    return c.json({
      code: 200,
      data: {
        results,
        uploaded: successCount,
        failed: files.length - successCount,
      },
      msg: successCount === files.length ? '批量上传成功' : `${successCount}/${files.length} 文件上传成功`,
    });
  } catch (error) {
    console.error('R2 batch upload error:', error);
    return c.json({
      code: 500,
      data: null,
      msg: '批量上传失败',
    }, 500);
  }
});

export { fileRoutes };
