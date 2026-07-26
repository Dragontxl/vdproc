import { useState, useEffect, useRef } from 'react';
import { Card, Table, Tag, Button, Modal, message, Upload, Popconfirm, Space, Breadcrumb, Empty, Checkbox, Input, Progress, Image } from 'antd';
import { 
  FolderOutlined, 
  FileOutlined, 
  DownloadOutlined, 
  DeleteOutlined, 
  UploadOutlined, 
  ArrowLeftOutlined,
  PlusOutlined,
  PlayCircleOutlined,
  EyeOutlined,
} from '@ant-design/icons';
import { fileApi } from '../api';
import dayjs from 'dayjs';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import VideoPlayer from '../components/VideoPlayer';

interface FileItem {
  name: string;
  key: string;
  size: number;
  type: 'file' | 'directory';
  lastModified: string;
  contentType?: string;
}

interface FileBrowserProps {
  initialPrefix?: string;
  rootPrefix?: string;
  embedded?: boolean;
}

export default function FileBrowser({ initialPrefix = '', rootPrefix = '', embedded = false }: FileBrowserProps = {}) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentPath, setCurrentPath] = useState(initialPrefix);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [allSelected, setAllSelected] = useState(false);
  const [isCreateFolderModalOpen, setIsCreateFolderModalOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [batchDownloadProgress, setBatchDownloadProgress] = useState(0);
  const [isBatchDownloading, setIsBatchDownloading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ [key: string]: number }>({});
  const [uploadingFiles, setUploadingFiles] = useState<Set<string>>(new Set());
  const [downloadProgress, setDownloadProgress] = useState<{ [key: string]: number }>({});
  const [downloadingFiles, setDownloadingFiles] = useState<Set<string>>(new Set());
  const [isVideoPlayerOpen, setIsVideoPlayerOpen] = useState(false);
  const [currentVideoUrl, setCurrentVideoUrl] = useState('');
  const [currentVideoName, setCurrentVideoName] = useState('');
  const [currentVideoPath, setCurrentVideoPath] = useState('');
  const [isImagePreviewOpen, setIsImagePreviewOpen] = useState(false);
  const [currentImageUrl, setCurrentImageUrl] = useState('');
  const [currentImageName, setCurrentImageName] = useState('');
  const [isJsonPreviewOpen, setIsJsonPreviewOpen] = useState(false);
  const [currentJsonContent, setCurrentJsonContent] = useState('');
  const [currentJsonName, setCurrentJsonName] = useState('');
  const [jsonLoading, setJsonLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const loadFiles = async (prefix: string = '') => {
    setLoading(true);
    try {
      let allFiles: FileItem[] = [];
      let cursor: string | undefined;
      let isTruncated = true;

      while (isTruncated) {
        const result = await fileApi.list({ prefix, delimiter: '/', cursor });
        const data = result.data;
        if (data?.files) {
          allFiles = [...allFiles, ...data.files];
        }
        isTruncated = data?.isTruncated || false;
        cursor = data?.cursor || undefined;
      }

      setFiles(allFiles);
      setCurrentPath(prefix);
      setSelectedKeys([]);
      setAllSelected(false);
    } catch (error) {
      console.error('Load files error:', error);
      message.error('加载文件列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFiles(initialPrefix);
  }, [initialPrefix]);

  const handleNavigate = (key: string) => {
    loadFiles(key);
  };

  const handleBack = () => {
    if (!currentPath || currentPath === rootPrefix) return;
    const parts = currentPath.split('/').filter(p => p);
    parts.pop();
    let newPath = parts.length > 0 ? parts.join('/') + '/' : '';
    if (rootPrefix && newPath.length < rootPrefix.length) {
      newPath = rootPrefix;
    }
    loadFiles(newPath);
  };

  const handleDownload = async (filename: string, key: string) => {
    try {
      setDownloadingFiles(prev => new Set(prev).add(key));
      setDownloadProgress(prev => ({ ...prev, [key]: 0 }));
      
      await fileApi.download(filename, currentPath, (progress) => {
        setDownloadProgress(prev => ({ ...prev, [key]: progress }));
      });
      
      message.success(`文件 ${filename} 下载成功`);
    } catch (error) {
      message.error('下载失败');
    } finally {
      setDownloadingFiles(prev => {
        const newSet = new Set(prev);
        newSet.delete(key);
        return newSet;
      });
      setDownloadProgress(prev => {
        const newProgress = { ...prev };
        delete newProgress[key];
        return newProgress;
      });
    }
  };

  const handlePreviewVideo = (filename: string, key: string) => {
    const videoUrl = fileApi.previewUrl(filename, currentPath);
    setCurrentVideoUrl(videoUrl);
    setCurrentVideoName(filename);
    setCurrentVideoPath(key);
    setIsVideoPlayerOpen(true);
  };

  const isVideoFile = (filename: string) => {
    const ext = filename.toLowerCase().split('.').pop();
    return ['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'wmv'].includes(ext || '');
  };

  const isImageFile = (filename: string) => {
    const ext = filename.toLowerCase().split('.').pop();
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext || '');
  };

  const handlePreviewImage = (filename: string) => {
    const imageUrl = fileApi.previewUrl(filename, currentPath);
    setCurrentImageUrl(imageUrl);
    setCurrentImageName(filename);
    setIsImagePreviewOpen(true);
  };

  const isJsonFile = (filename: string) => {
    return filename.toLowerCase().endsWith('.json');
  };

  const handlePreviewJson = async (filename: string, key: string) => {
    setIsJsonPreviewOpen(true);
    setCurrentJsonName(filename);
    setJsonLoading(true);
    setCurrentJsonContent('');
    try {
      const blob = await fileApi.downloadAsBlob(filename, key.substring(0, key.lastIndexOf('/') + 1));
      const text = await blob.text();
      try {
        const parsed = JSON.parse(text);
        setCurrentJsonContent(JSON.stringify(parsed, null, 2));
      } catch {
        setCurrentJsonContent(text);
      }
    } catch (error) {
      console.error('Failed to load JSON:', error);
      message.error('加载 JSON 文件失败');
      setIsJsonPreviewOpen(false);
    } finally {
      setJsonLoading(false);
    }
  };

  const handleDelete = async (filename: string, key: string, isDirectory: boolean = false) => {
    try {
      await fileApi.delete(filename, currentPath, isDirectory);
      message.success(isDirectory ? '文件夹删除成功' : '删除成功');
      loadFiles(currentPath);
    } catch (error) {
      message.error('删除失败');
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) {
      message.warning('请输入文件夹名称');
      return;
    }
    try {
      await fileApi.createFolder(newFolderName.trim(), currentPath);
      message.success(`文件夹 ${newFolderName} 创建成功`);
      setIsCreateFolderModalOpen(false);
      setNewFolderName('');
      loadFiles(currentPath);
    } catch (error) {
      message.error(`创建失败: ${(error as any)?.response?.data?.msg || '未知错误'}`);
    }
  };

  const handleBatchDelete = async () => {
    if (selectedKeys.length === 0) {
      message.warning('请选择要删除的文件或文件夹');
      return;
    }
    try {
      const filesToDelete = selectedKeys.filter(k => !k.endsWith('/'));
      const foldersToDelete = selectedKeys.filter(k => k.endsWith('/'));

      let deletedCount = 0;

      if (filesToDelete.length > 0) {
        await fileApi.batchDelete(filesToDelete);
        deletedCount += filesToDelete.length;
      }

      for (const folderKey of foldersToDelete) {
        const folderName = folderKey.replace(/\/$/, '').split('/').pop() || folderKey;
        const prefix = folderKey.replace(folderName + '/', '');
        await fileApi.delete(folderName, prefix, true);
        deletedCount += 1;
      }

      message.success(`成功删除 ${deletedCount} 个项目`);
      loadFiles(currentPath);
    } catch (error) {
      message.error('批量删除失败');
    }
  };

  const handleBatchDownload = async () => {
    if (selectedKeys.length === 0) {
      message.warning('请选择要下载的文件或文件夹');
      return;
    }

    setIsBatchDownloading(true);
    setBatchDownloadProgress(0);

    try {
      const zip = new JSZip();
      const allFiles: { key: string; name: string }[] = [];

      for (const key of selectedKeys) {
        if (key.endsWith('/')) {
          const folderFiles = await fileApi.listAllFiles(key);
          allFiles.push(...folderFiles);
        } else {
          const filename = key.split('/').pop() || key;
          allFiles.push({ key, name: filename });
        }
      }

      if (allFiles.length === 0) {
        message.warning('没有找到可下载的文件');
        return;
      }

      let downloadedCount = 0;

      for (const file of allFiles) {
        try {
          const blob = await fileApi.downloadAsBlob(file.key.split('/').pop() || file.key, file.key.substring(0, file.key.lastIndexOf('/') + 1));
          zip.file(file.name, blob);
        } catch (error) {
          message.warning(`下载 ${file.name} 失败`);
        }
        downloadedCount++;
        setBatchDownloadProgress((downloadedCount / allFiles.length) * 100);
      }

      const content = await zip.generateAsync({ type: 'blob' });
      const zipName = currentPath ? `${currentPath.replace(/\/$/, '').split('/').pop()}_files.zip` : 'files.zip';
      saveAs(content, zipName);
      message.success(`成功下载 ${allFiles.length} 个文件`);
    } catch (error) {
      message.error('批量下载失败');
    } finally {
      setIsBatchDownloading(false);
      setBatchDownloadProgress(0);
    }
  };

  const CHUNK_SIZE = 5 * 1024 * 1024;

  const handleUpload = async (file: File, prefix?: string) => {
    const key = `${file.name}_${file.size}_${Date.now()}`;
    setUploadingFiles(prev => new Set(prev).add(key));
    setUploadProgress(prev => ({ ...prev, [key]: 0 }));

    try {
      if (file.size < CHUNK_SIZE) {
        await fileApi.upload(file, prefix || currentPath, (progress) => {
          setUploadProgress(prev => ({ ...prev, [key]: progress }));
        });
      } else {
        await uploadWithMultipart(file, prefix || currentPath, key);
      }
      message.success(`文件 ${file.name} 上传成功`);
      loadFiles(currentPath);
    } catch (error) {
      message.error(`上传失败: ${(error as any)?.response?.data?.msg || '未知错误'}`);
    } finally {
      setUploadingFiles(prev => {
        const newSet = new Set(prev);
        newSet.delete(key);
        return newSet;
      });
      setUploadProgress(prev => {
        const newProgress = { ...prev };
        delete newProgress[key];
        return newProgress;
      });
    }
  };

  const uploadWithMultipart = async (file: File, prefix: string, key: string) => {
    const initResult = await fileApi.multipartInit(file.name, prefix);
    const uploadId = initResult.data?.uploadId;
    const r2Key = initResult.data?.key;
    
    if (!uploadId || !r2Key) {
      throw new Error('初始化分片上传失败');
    }

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);
      
      await fileApi.multipartUpload(uploadId, i + 1, r2Key, chunk);
      
      const progress = Math.round(((i + 1) / totalChunks) * 100);
      setUploadProgress(prev => ({ ...prev, [key]: progress }));
    }

    await fileApi.multipartComplete(uploadId, r2Key);
  };

  const handleBatchUpload = (files: File[]) => {
    files.forEach(file => {
      handleUpload(file);
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      handleBatchUpload(Array.from(files));
    }
    e.target.value = '';
  };

  const collectFilesFromDrop = async (items: DataTransferItemList): Promise<{ file: File; relativePath: string }[]> => {
    const results: { file: File; relativePath: string }[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry) {
          const collectEntry = async (entry: FileSystemEntry, basePath: string = '') => {
            if (entry.isFile) {
              const fileEntry = entry as FileSystemFileEntry;
              await new Promise<void>((resolve) => {
                fileEntry.file((file) => {
                  const relativePath = basePath ? `${basePath}/${file.name}` : file.name;
                  results.push({ file, relativePath });
                  resolve();
                });
              });
            } else if (entry.isDirectory) {
              const dirEntry = entry as FileSystemDirectoryEntry;
              await new Promise<void>((resolve) => {
                const reader = dirEntry.createReader();
                reader.readEntries(async (entries) => {
                  for (const subEntry of entries) {
                    const newBasePath = basePath ? `${basePath}/${dirEntry.name}` : dirEntry.name;
                    await collectEntry(subEntry, newBasePath);
                  }
                  resolve();
                });
              });
            }
          };
          await collectEntry(entry);
        } else {
          const file = item.getAsFile();
          if (file) {
            results.push({ file, relativePath: file.name });
          }
        }
      }
    }

    return results;
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const { items } = e.dataTransfer;
    if (!items || items.length === 0) return;

    try {
      const filesToUpload = await collectFilesFromDrop(items);
      if (filesToUpload.length === 0) {
        message.warning('没有找到可上传的文件');
        return;
      }

      message.info(`开始上传 ${filesToUpload.length} 个文件...`);

      for (const { file, relativePath } of filesToUpload) {
        const folderPath = relativePath.substring(0, relativePath.lastIndexOf('/'));
        const uploadPrefix = folderPath ? `${currentPath}${folderPath}/` : currentPath;
        await handleUpload(file, uploadPrefix);
      }

      message.success(`上传完成`);
    } catch (error) {
      message.error('拖放上传失败');
    }
  };

  const toggleSelect = (key: string) => {
    setSelectedKeys(prev => 
      prev.includes(key) 
        ? prev.filter(k => k !== key)
        : [...prev, key]
    );
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedKeys([]);
    } else {
      setSelectedKeys(files.map(f => f.key));
    }
    setAllSelected(!allSelected);
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getFileIcon = (file: FileItem) => {
    if (file.type === 'directory') {
      return <FolderOutlined style={{ color: '#1890ff' }} />;
    }
    const name = file.name.toLowerCase();
    if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.gif')) {
      return <FileOutlined style={{ color: '#52c41a' }} />;
    }
    if (name.endsWith('.mp4') || name.endsWith('.avi') || name.endsWith('.mov')) {
      return <FileOutlined style={{ color: '#eb2f96' }} />;
    }
    if (name.endsWith('.json') || name.endsWith('.txt') || name.endsWith('.log')) {
      return <FileOutlined style={{ color: '#1890ff' }} />;
    }
    return <FileOutlined style={{ color: '#999' }} />;
  };

  const breadcrumbItems = () => {
    const items: { title: string; onClick?: () => void }[] = [];
    if (rootPrefix) {
      const rootName = rootPrefix.replace(/\/$/, '').split('/').pop() || '根目录';
      items.push({ title: rootName, onClick: () => loadFiles(rootPrefix) });
      if (currentPath && currentPath !== rootPrefix && currentPath.startsWith(rootPrefix)) {
        const relativePath = currentPath.replace(rootPrefix, '');
        const parts = relativePath.split('/').filter(p => p);
        let path = rootPrefix;
        parts.forEach(part => {
          path += part + '/';
          items.push({ title: part, onClick: () => loadFiles(path) });
        });
      }
    } else {
      items.push({ title: '根目录', onClick: () => loadFiles('') });
      if (currentPath) {
        const parts = currentPath.split('/').filter(p => p);
        let path = '';
        parts.forEach(part => {
          path += part + '/';
          items.push({ title: part, onClick: () => loadFiles(path) });
        });
      }
    }
    return items;
  };

  const columns = [
    {
      title: (
        <Checkbox
          checked={selectedKeys.length === files.length && files.length > 0}
          indeterminate={selectedKeys.length > 0 && selectedKeys.length < files.length}
          onChange={toggleSelectAll}
          disabled={files.length === 0}
        />
      ),
      key: 'checkbox',
      width: 50,
      render: (_: any, record: FileItem) => (
        <Checkbox
          checked={selectedKeys.includes(record.key)}
          onChange={() => toggleSelect(record.key)}
        />
      ),
    },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      render: (_: any, record: FileItem) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {getFileIcon(record)}
          <span
            onClick={() => record.type === 'directory' && handleNavigate(record.key)}
            style={{ cursor: record.type === 'directory' ? 'pointer' : 'default', color: record.type === 'directory' ? '#1890ff' : undefined }}
          >
            {record.name}
          </span>
        </div>
      ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 80,
      render: (type: string) => (
        <Tag color={type === 'directory' ? 'blue' : 'gray'}>
          {type === 'directory' ? '文件夹' : '文件'}
        </Tag>
      ),
    },
    {
      title: '大小',
      dataIndex: 'size',
      key: 'size',
      width: 120,
      render: (size: number) => formatSize(size),
    },
    {
      title: '修改时间',
      dataIndex: 'lastModified',
      key: 'lastModified',
      width: 150,
      render: (time: string) => time ? dayjs(time).format('YYYY-MM-DD HH:mm') : '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_: any, record: FileItem) => (
        <Space>
          {record.type === 'file' && (
            <>
              {isVideoFile(record.name) && (
                <Button size="small" icon={<PlayCircleOutlined />} onClick={() => handlePreviewVideo(record.name, record.key)}>
                  播放
                </Button>
              )}
              {isImageFile(record.name) && (
                <Button size="small" icon={<EyeOutlined />} onClick={() => handlePreviewImage(record.name)}>
                  预览
                </Button>
              )}
              {isJsonFile(record.name) && (
                <Button size="small" icon={<EyeOutlined />} onClick={() => handlePreviewJson(record.name, record.key)}>
                  预览
                </Button>
              )}
              <Button size="small" icon={<DownloadOutlined />} onClick={() => handleDownload(record.name, record.key)} loading={downloadingFiles.has(record.key)}>
                {downloadingFiles.has(record.key) ? `${downloadProgress[record.key]}%` : '下载'}
              </Button>
              {downloadingFiles.has(record.key) && (
                <Progress percent={downloadProgress[record.key]} size="small" status="active" />
              )}
              <Popconfirm
                title={`确定要删除 ${record.name} 吗？`}
                onConfirm={() => handleDelete(record.name, record.key)}
                okText="确定"
                cancelText="取消"
              >
                <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
              </Popconfirm>
            </>
          )}
          {record.type === 'directory' && (
            <Space>
              <Button size="small" onClick={() => handleNavigate(record.key)}>进入</Button>
              <Popconfirm
                title={`确定要删除文件夹 ${record.name} 及其所有内容吗？`}
                onConfirm={() => handleDelete(record.name, record.key, true)}
                okText="确定"
                cancelText="取消"
              >
                <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
              </Popconfirm>
            </Space>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <Breadcrumb items={breadcrumbItems()} style={{ marginBottom: 16 }} />
          {!embedded && <h2>文件管理</h2>}
        </div>
        <Space>
          {currentPath && currentPath !== rootPrefix && (
            <Button icon={<ArrowLeftOutlined />} onClick={handleBack}>
              返回上级
            </Button>
          )}
          {selectedKeys.length > 0 && (
            <Space>
              <Button icon={<DownloadOutlined />} onClick={handleBatchDownload} loading={isBatchDownloading}>
                批量下载 ({selectedKeys.length})
              </Button>
              <Button danger icon={<DeleteOutlined />} onClick={handleBatchDelete}>
                批量删除 ({selectedKeys.length})
              </Button>
            </Space>
          )}
          <Upload
            beforeUpload={(file) => {
              handleUpload(file);
              return false;
            }}
            showUploadList={false}
          >
            <Button icon={<UploadOutlined />}>上传文件</Button>
          </Upload>
          <Button
            icon={<UploadOutlined />}
            onClick={() => fileInputRef.current?.click()}
          >
            批量上传
          </Button>
          <Button
            icon={<PlusOutlined />}
            onClick={() => setIsCreateFolderModalOpen(true)}
          >
            新建文件夹
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
        </Space>
      </div>

      {isBatchDownloading && (
        <div style={{ marginBottom: 16 }}>
          <Progress percent={Math.round(batchDownloadProgress)} status="active" />
        </div>
      )}

      {uploadingFiles.size > 0 && (
        <div style={{ marginBottom: 16 }}>
          {Array.from(uploadingFiles).map(key => (
            <div key={key} style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span>{key.split('_')[0]}</span>
                <span>{uploadProgress[key]}%</span>
              </div>
              <Progress percent={uploadProgress[key]} status="active" />
            </div>
          ))}
        </div>
      )}

      <Card
        style={{
          border: isDragOver ? '2px dashed #1890ff' : (embedded ? 'none' : undefined),
          backgroundColor: isDragOver ? '#e6f7ff' : undefined,
          transition: 'all 0.3s ease',
        }}
      >
        <div
          ref={dropZoneRef}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{
            minHeight: '200px',
            padding: '20px',
            border: isDragOver ? '2px dashed #1890ff' : '2px dashed #d9d9d9',
            borderRadius: '8px',
            backgroundColor: isDragOver ? '#e6f7ff' : '#fafafa',
            transition: 'all 0.3s ease',
            cursor: 'pointer',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <UploadOutlined style={{ fontSize: isDragOver ? '64px' : '48px', color: isDragOver ? '#1890ff' : '#999', marginBottom: '16px' }} />
          <p style={{ fontSize: isDragOver ? '20px' : '16px', color: isDragOver ? '#1890ff' : '#666', marginBottom: '8px' }}>
            {isDragOver ? '松开鼠标上传文件' : '拖拽文件或文件夹到此处上传'}
          </p>
          <p style={{ fontSize: '14px', color: '#999' }}>支持单个文件、多个文件或整个文件夹</p>
        </div>

        {files.length > 0 && (
          <div style={{ marginTop: '16px' }}>
            <Table
              dataSource={files}
              columns={columns}
              loading={loading}
              rowKey="key"
              pagination={{ pageSize: 20 }}
            />
          </div>
        )}
      </Card>

      <Modal
        title="新建文件夹"
        open={isCreateFolderModalOpen}
        onOk={handleCreateFolder}
        onCancel={() => {
          setIsCreateFolderModalOpen(false);
          setNewFolderName('');
        }}
      >
        <Input
          placeholder="请输入文件夹名称"
          value={newFolderName}
          onChange={(e) => setNewFolderName(e.target.value)}
          style={{ width: '100%' }}
        />
      </Modal>

      <VideoPlayer
        open={isVideoPlayerOpen}
        onClose={() => setIsVideoPlayerOpen(false)}
        videoUrl={currentVideoUrl}
        videoName={currentVideoName}
        filePath={currentVideoPath}
      />

      <Modal
        title={currentImageName}
        open={isImagePreviewOpen}
        onCancel={() => setIsImagePreviewOpen(false)}
        footer={null}
        width={720}
        centered
        destroyOnClose
      >
        <div style={{ display: 'flex', justifyContent: 'center', maxHeight: '70vh', overflow: 'auto' }}>
          <Image
            src={currentImageUrl}
            alt={currentImageName}
            style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
          />
        </div>
      </Modal>

      <Modal
        title={currentJsonName}
        open={isJsonPreviewOpen}
        onCancel={() => setIsJsonPreviewOpen(false)}
        footer={null}
        width={900}
        centered
        destroyOnClose
      >
        <div style={{ maxHeight: '70vh', overflow: 'auto' }}>
          {jsonLoading ? (
            <p style={{ textAlign: 'center', padding: '40px' }}>加载中...</p>
          ) : (
            <pre
              style={{
                background: '#f5f5f5',
                padding: '16px',
                borderRadius: '8px',
                fontSize: '13px',
                fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                margin: 0,
              }}
            >
              {currentJsonContent}
            </pre>
          )}
        </div>
      </Modal>
    </div>
  );
}
