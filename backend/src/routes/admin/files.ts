import { Hono } from 'hono';
import { Bindings } from '../../types/env';

const fileRoutes = new Hono();

async function purgeCloudflareCache(c: any, keys: string[]) {
  const { R2_PUBLIC_URL, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID } = c.env as Bindings;

  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ZONE_ID || !R2_PUBLIC_URL) {
    console.log('Cloudflare purge configuration not set, skipping cache purge');
    return;
  }

  try {
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
    } else {
      console.error('Cloudflare cache purge failed:', result);
    }
  } catch (error) {
    console.error('Cloudflare cache purge error:', error);
  }
}

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
          folderCursor = (folderObjects as any).cursor;
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
        cursor: (objects as any).cursor,
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

fileRoutes.get('/preview/:filename', async (c) => {
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
        cursor = (objects as any).cursor;

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
              subCursor = (subObjects as any).cursor;
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
    const file = formData.get('file') as unknown as File;
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

    purgeCloudflareCache(c, [key]);

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
    const files = formData.getAll('files') as unknown as File[];
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

        await R2.put(key, file.stream(), {
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
        const errStr = (error as Error)?.message || (typeof error === 'string' ? error : JSON.stringify(error));
        results.push({
          key: '',
          name: file.name,
          size: file.size,
          success: false,
          error: errStr,
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const successKeys = results.filter(r => r.success).map(r => r.key);
    
    if (successKeys.length > 0) {
      purgeCloudflareCache(c, successKeys);
    }
    
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
  const { R2, DB } = c.env as Bindings;

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

    // 使用 R2 原生分片上传，避免 Worker 内存限制
    const multipartUpload = await R2.createMultipartUpload(key, {
      httpMetadata: {
        contentType: 'application/octet-stream',
      },
    });
    const uploadId = multipartUpload.uploadId;

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
    const file = formData.get('file') as unknown as File;
    
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

    // 使用 R2 原生分片上传，分片数据直接传给 R2，不经过 Worker 内存持久化
    const multipartUpload = R2.resumeMultipartUpload(key, uploadId);
    const uploadedPart = await multipartUpload.uploadPart(partNumber, file);

    await DB.prepare('INSERT INTO upload_parts (upload_id, part_number, etag) VALUES (?, ?, ?)')
      .bind(uploadId, partNumber, uploadedPart.etag)
      .run();

    console.log(`Multipart upload success: uploadId=${uploadId}, partNumber=${partNumber}, etag=${uploadedPart.etag}`);

    return c.json({
      code: 200,
      data: {
        partNumber,
        etag: uploadedPart.etag,
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

    const parts = (partsResult.results || []).map((p: any) => ({
      partNumber: Number(p.part_number),
      etag: String(p.etag ?? ''),
    })).filter((p: any) => Number.isFinite(p.partNumber) && p.partNumber > 0 && p.etag);

    if (parts.length === 0) {
      return c.json({
        code: 400,
        data: null,
        msg: '没有上传任何分片',
      }, 400);
    }

    // 校验分片序号从 1 开始连续
    parts.sort((a, b) => a.partNumber - b.partNumber);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].partNumber !== i + 1) {
        return c.json({
          code: 400,
          data: null,
          msg: `分片序号不连续: 期望 ${i + 1}, 实际 ${parts[i].partNumber}`,
        }, 400);
      }
    }

    console.log(`Multipart complete parts: uploadId=${uploadId}, parts=${parts.length}, firstPart=${parts[0].partNumber}, lastPart=${parts[parts.length-1].partNumber}, sampleEtag=${parts[0].etag.substring(0,16)}...`);

    // R2 服务端合并分片，零文件数据经过 Worker 内存
    const multipartUpload = R2.resumeMultipartUpload(key, uploadId);
    const completedObject = await multipartUpload.complete(parts);

    await DB.prepare('UPDATE uploads SET status = ? WHERE upload_id = ?')
      .bind('completed', uploadId)
      .run();

    await DB.prepare('DELETE FROM upload_parts WHERE upload_id = ?')
      .bind(uploadId)
      .run();

    console.log(`Multipart upload completed: key=${key}, size=${completedObject.size}`);

    purgeCloudflareCache(c, [key]);

    return c.json({
      code: 200,
      data: {
        key,
        size: completedObject.size,
      },
      msg: '文件上传完成',
    });
  } catch (error: any) {
    const errStr = error?.message || (typeof error === 'string' ? error : JSON.stringify(error));
    console.error('Multipart complete error:', errStr, error?.stack || '');
    return c.json({
      code: 500,
      data: null,
      msg: `完成上传失败: ${errStr || '未知错误'}`,
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

    // R2 原生取消分片上传，服务端自动清理分片
    const multipartUpload = R2.resumeMultipartUpload(key, uploadId);
    await multipartUpload.abort();

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