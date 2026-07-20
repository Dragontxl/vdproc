import { Hono } from 'hono';
import { Bindings } from '../../types/env';

const fileRoutes = new Hono();

fileRoutes.get('/', async (c) => {
  const { R2 } = c.env as Bindings;
  const prefix = c.req.query('prefix') || '';
  const delimiter = c.req.query('delimiter') || '/';
  const cursor = c.req.query('cursor') || undefined;

  try {
    const objects = await R2.list({
      prefix,
      delimiter,
      cursor,
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
        let folderSize = 0;
        let folderCursor: string | undefined;
        let folderTruncated = true;
        
        while (folderTruncated) {
          const folderObjects = await R2.list({
            prefix: prefix,
            cursor: folderCursor,
            limit: 1000,
          });
          
          for (const obj of folderObjects.objects || []) {
            folderSize += obj.size;
          }
          
          folderTruncated = folderObjects.truncated;
          folderCursor = folderObjects.cursor;
        }
        
        files.push({
          name: prefix.replace(/\/$/, '').split('/').pop() || prefix,
          key: prefix,
          size: folderSize,
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
        cursor: objects.cursor,
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
    
    const stream = file.stream();
    
    await R2.put(key, stream, {
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
  } catch (error: any) {
    console.error('R2 upload error:', error);
    if (error.message?.includes('out of memory') || error.message?.includes('size limit')) {
      return c.json({
        code: 413,
        data: null,
        msg: '文件过大，请使用分片上传',
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

fileRoutes.post('/multipart/init', async (c) => {
  const { DB } = c.env as Bindings;
  
  try {
    const body = await c.req.json();
    const { filename, prefix = '' } = body;
    
    if (!filename) {
      return c.json({
        code: 400,
        data: null,
        msg: '缺少文件名',
      }, 400);
    }

    const key = prefix ? `${prefix}${filename}` : filename;
    const uploadId = crypto.randomUUID();

    await DB.prepare('INSERT INTO uploads (upload_id, key, status, created_at) VALUES (?, ?, ?, ?)')
      .bind(uploadId, key, 'uploading', new Date().toISOString())
      .run();

    console.log(`Multipart init: uploadId=${uploadId}, key=${key}`);

    return c.json({
      code: 200,
      data: {
        uploadId,
        key,
      },
      msg: '分片上传初始化成功',
    });
  } catch (error: any) {
    console.error('Multipart init error:', error, error?.message);
    return c.json({
      code: 500,
      data: null,
      msg: `初始化分片上传失败: ${error?.message || '未知错误'}`,
    }, 500);
  }
});

fileRoutes.post('/multipart/upload', async (c) => {
  const { R2, DB } = c.env as Bindings;
  
  try {
    const formData = await c.req.formData();
    const uploadId = formData.get('uploadId') as string;
    const partNumberStr = formData.get('partNumber') as string;
    const key = formData.get('key') as string;
    const file = formData.get('file') as File;
    
    if (!uploadId) {
      return c.json({
        code: 400,
        data: null,
        msg: '缺少 uploadId',
      }, 400);
    }

    if (!key) {
      return c.json({
        code: 400,
        data: null,
        msg: '缺少 key',
      }, 400);
    }

    const partNumber = parseInt(partNumberStr);
    if (!partNumber || isNaN(partNumber)) {
      return c.json({
        code: 400,
        data: null,
        msg: '缺少或无效的 partNumber',
      }, 400);
    }

    if (!file) {
      return c.json({
        code: 400,
        data: null,
        msg: '缺少文件数据',
      }, 400);
    }

    console.log(`Multipart upload: uploadId=${uploadId}, key=${key}, partNumber=${partNumber}, fileSize=${file.size}`);

    const result = await DB.prepare('SELECT key, status FROM uploads WHERE upload_id = ?')
      .bind(uploadId)
      .first();

    if (!result || result.status !== 'uploading') {
      return c.json({
        code: 400,
        data: null,
        msg: '上传会话不存在或已完成',
      }, 400);
    }

    const arrayBuffer = await file.arrayBuffer();
    const partKey = `${uploadId}/part_${partNumber}`;
    
    await R2.put(partKey, arrayBuffer, {
      httpMetadata: {
        contentType: file.type || 'application/octet-stream',
      },
    });

    const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const etag = Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    await DB.prepare('INSERT INTO upload_parts (upload_id, part_number, etag) VALUES (?, ?, ?)')
      .bind(uploadId, partNumber, etag)
      .run();

    console.log(`Multipart upload success: uploadId=${uploadId}, partNumber=${partNumber}, etag=${etag}`);

    return c.json({
      code: 200,
      data: {
        partNumber,
        etag,
      },
      msg: '分片上传成功',
    });
  } catch (error: any) {
    console.error('Multipart upload error:', error, error?.message, error?.stack);
    return c.json({
      code: 500,
      data: null,
      msg: `分片上传失败: ${error?.message || '未知错误'}`,
    }, 500);
  }
});

fileRoutes.post('/multipart/complete', async (c) => {
  const { R2, DB } = c.env as Bindings;
  
  try {
    const body = await c.req.json();
    const { uploadId, key } = body;
    
    if (!uploadId || !key) {
      return c.json({
        code: 400,
        data: null,
        msg: '缺少 uploadId 或 key',
      }, 400);
    }

    console.log(`Completing multipart upload: uploadId=${uploadId}, key=${key}`);

    const result = await DB.prepare('SELECT key, status FROM uploads WHERE upload_id = ?')
      .bind(uploadId)
      .first();

    if (!result || result.status !== 'uploading') {
      return c.json({
        code: 400,
        data: null,
        msg: '上传会话不存在或已完成',
      }, 400);
    }

    const partsResult = await DB.prepare('SELECT part_number, etag FROM upload_parts WHERE upload_id = ? ORDER BY part_number')
      .bind(uploadId)
      .all();

    const parts = (partsResult.results || []) as { part_number: number; etag: string }[];

    if (parts.length === 0) {
      return c.json({
        code: 400,
        data: null,
        msg: '没有上传任何分片',
      }, 400);
    }

    let totalSize = 0;
    const partBuffers: Uint8Array[] = [];
    
    for (const part of parts) {
      const partKey = `${uploadId}/part_${part.part_number}`;
      const partObj = await R2.get(partKey);
      
      if (!partObj || !partObj.body) {
        return c.json({
          code: 500,
          data: null,
          msg: `分片 ${part.part_number} 不存在`,
        }, 500);
      }

      const partBuffer = await partObj.arrayBuffer();
      partBuffers.push(new Uint8Array(partBuffer));
      totalSize += partBuffer.byteLength;

      await R2.delete(partKey);
    }

    const combinedBuffer = new Uint8Array(totalSize);
    let offset = 0;
    for (const buffer of partBuffers) {
      combinedBuffer.set(buffer, offset);
      offset += buffer.length;
    }

    await R2.put(key, combinedBuffer, {
      httpMetadata: {
        contentType: 'application/octet-stream',
      },
    });

    await DB.prepare('UPDATE uploads SET status = ? WHERE upload_id = ?')
      .bind('completed', uploadId)
      .run();

    await DB.prepare('DELETE FROM upload_parts WHERE upload_id = ?')
      .bind(uploadId)
      .run();

    console.log(`Multipart upload completed: key=${key}, size=${totalSize}`);

    return c.json({
      code: 200,
      data: {
        key,
        size: totalSize,
      },
      msg: '文件上传完成',
    });
  } catch (error: any) {
    console.error('Multipart complete error:', error, error?.message, error?.stack);
    return c.json({
      code: 500,
      data: null,
      msg: `完成上传失败: ${error?.message || '未知错误'}`,
    }, 500);
  }
});

fileRoutes.post('/multipart/abort', async (c) => {
  const { R2, DB } = c.env as Bindings;
  
  try {
    const body = await c.req.json();
    const { uploadId, key } = body;
    
    if (!uploadId || !key) {
      return c.json({
        code: 400,
        data: null,
        msg: '缺少 uploadId 或 key',
      }, 400);
    }

    const listResult = await R2.list({
      prefix: `${uploadId}/`,
    });

    for (const obj of listResult.objects || []) {
      await R2.delete(obj.key);
    }

    await DB.prepare('UPDATE uploads SET status = ? WHERE upload_id = ?')
      .bind('aborted', uploadId)
      .run();

    await DB.prepare('DELETE FROM upload_parts WHERE upload_id = ?')
      .bind(uploadId)
      .run();

    return c.json({
      code: 200,
      data: null,
      msg: '上传已取消',
    });
  } catch (error: any) {
    console.error('Multipart abort error:', error);
    return c.json({
      code: 500,
      data: null,
      msg: '取消上传失败',
    }, 500);
  }
});

export { fileRoutes };