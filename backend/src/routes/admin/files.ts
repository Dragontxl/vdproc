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
  const isDirectory = c.req.query('is_directory') === 'true';
  
  const key = prefix ? `${prefix}${filename}` : filename;

  try {
    if (isDirectory) {
      const folderPrefix = key.endsWith('/') ? key : `${key}/`;
      let deletedCount = 0;
      let truncated = true;
      let cursor: string | undefined;

      while (truncated) {
        const objects = await R2.list({
          prefix: folderPrefix,
          cursor,
          limit: 1000,
        });

        truncated = objects.truncated;
        cursor = objects.cursor;

        if (objects.objects) {
          for (const obj of objects.objects) {
            await R2.delete(obj.key);
            deletedCount++;
          }
        }

        if (objects.delimitedPrefixes) {
          for (const subPrefix of objects.delimitedPrefixes) {
            let subTruncated = true;
            let subCursor: string | undefined;
            while (subTruncated) {
              const subObjects = await R2.list({
                prefix: subPrefix,
                cursor: subCursor,
                limit: 1000,
              });
              subTruncated = subObjects.truncated;
              subCursor = subObjects.cursor;
              if (subObjects.objects) {
                for (const obj of subObjects.objects) {
                  await R2.delete(obj.key);
                  deletedCount++;
                }
              }
            }
          }
        }
      }

      return c.json({
        code: 200,
        data: { deletedCount },
        msg: `文件夹删除成功，共删除 ${deletedCount} 个文件`,
      });
    } else {
      await R2.delete(key);
      
      return c.json({
        code: 200,
        data: null,
        msg: '文件删除成功',
      });
    }
  } catch (error) {
    console.error('R2 delete error:', error);
    return c.json({
      code: 500,
      data: null,
      msg: '删除失败',
    }, 500);
  }
});

fileRoutes.post('/create-folder', async (c) => {
  const { R2 } = c.env as Bindings;
  
  try {
    const body = await c.req.json().catch(() => ({}));
    const { name, prefix } = body;
    
    if (!name) {
      return c.json({
        code: 400,
        data: null,
        msg: '请提供文件夹名称',
      }, 400);
    }

    const folderKey = (prefix || '') + name.replace(/\/$/, '') + '/';
    
    await R2.put(folderKey, new ArrayBuffer(0), {
      httpMetadata: {
        contentType: 'application/x-directory',
      },
    });

    return c.json({
      code: 200,
      data: {
        key: folderKey,
        name: name.replace(/\/$/, ''),
      },
      msg: '文件夹创建成功',
    });
  } catch (error) {
    console.error('R2 create folder error:', error);
    return c.json({
      code: 500,
      data: null,
      msg: '创建文件夹失败',
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
    const contentType = c.req.header('content-type') || '';
    
    if (!contentType.includes('multipart/form-data')) {
      return c.json({
        code: 400,
        data: null,
        msg: '请使用 multipart/form-data 格式上传',
      }, 400);
    }

    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      return c.json({
        code: 400,
        data: null,
        msg: '不支持的请求格式',
      }, 400);
    }

    const boundary = `--${boundaryMatch[1]}`;
    const reader = c.req.raw.body.getReader();
    
    let fileName = '';
    let prefix = '';
    let fileBuffer = new Uint8Array(0);
    let inFile = false;
    let headerParsed = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (!inFile) {
        const str = new TextDecoder().decode(value);
        
        if (!fileName && str.includes('filename=')) {
          const fileNameMatch = str.match(/filename="([^"]+)"/);
          if (fileNameMatch) {
            fileName = fileNameMatch[1];
          }
        }
        
        if (!prefix && str.includes('name="prefix"')) {
          const prefixMatch = str.match(/name="prefix"\r\n\r\n([^\r\n]+)/);
          if (prefixMatch) {
            prefix = prefixMatch[1];
          }
        }

        if (fileName && !headerParsed) {
          const headerEnd = str.indexOf('\r\n\r\n');
          if (headerEnd !== -1) {
            headerParsed = true;
            inFile = true;
            const fileStart = headerEnd + 4;
            fileBuffer = value.slice(fileStart);
          }
        }
      } else {
        const newBuffer = new Uint8Array(fileBuffer.length + value.length);
        newBuffer.set(fileBuffer, 0);
        newBuffer.set(value, fileBuffer.length);
        fileBuffer = newBuffer;
      }
    }

    if (!fileName) {
      return c.json({
        code: 400,
        data: null,
        msg: '未找到文件名',
      }, 400);
    }

    if (fileBuffer.length === 0) {
      return c.json({
        code: 400,
        data: null,
        msg: '未找到文件数据',
      }, 400);
    }

    const boundaryBytes = new TextEncoder().encode(`\r\n${boundary}--`);
    let fileEnd = fileBuffer.length;
    
    for (let i = 0; i <= fileBuffer.length - boundaryBytes.length; i++) {
      let match = true;
      for (let j = 0; j < boundaryBytes.length; j++) {
        if (fileBuffer[i + j] !== boundaryBytes[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        fileEnd = i;
        break;
      }
    }

    const fileData = fileBuffer.slice(0, fileEnd);
    const key = prefix ? `${prefix}${fileName}` : fileName;
    
    await R2.put(key, fileData, {
      httpMetadata: {
        contentType: 'application/octet-stream',
      },
    });

    return c.json({
      code: 200,
      data: {
        key,
        name: fileName,
        size: fileData.length,
        contentType: 'application/octet-stream',
      },
      msg: '文件上传成功',
    });
  } catch (error: any) {
    console.error('R2 upload error:', error);
    if (error.message?.includes('out of memory') || error.message?.includes('size limit')) {
      return c.json({
        code: 413,
        data: null,
        msg: '文件过大，无法上传',
      }, 413);
    }
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
