import { useState, useEffect, useRef } from 'react';
import { Card, Table, Tag, Button, Modal, message, Upload, Popconfirm, Space, Breadcrumb, Empty, Checkbox, Input } from 'antd';
import { 
  FolderOutlined, 
  FileOutlined, 
  DownloadOutlined, 
  DeleteOutlined, 
  UploadOutlined, 
  ArrowLeftOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { fileApi } from '../api';
import dayjs from 'dayjs';

interface FileItem {
  name: string;
  key: string;
  size: number;
  type: 'file' | 'directory';
  lastModified: string;
  contentType?: string;
}

export default function FileBrowser() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [allSelected, setAllSelected] = useState(false);
  const [isCreateFolderModalOpen, setIsCreateFolderModalOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadFiles = async (prefix: string = '') => {
    setLoading(true);
    try {
      const result = await fileApi.list({ prefix, delimiter: '/' });
      setFiles(result.data?.files || []);
      setCurrentPath(prefix);
      setSelectedKeys([]);
      setAllSelected(false);
    } catch (error) {
      message.error('加载文件列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFiles();
  }, []);

  const handleNavigate = (key: string) => {
    loadFiles(key);
  };

  const handleBack = () => {
    if (!currentPath) return;
    const parts = currentPath.split('/').filter(p => p);
    parts.pop();
    const newPath = parts.length > 0 ? parts.join('/') + '/' : '';
    loadFiles(newPath);
  };

  const handleDownload = (filename: string, key: string) => {
    const url = fileApi.download(filename, currentPath);
    window.open(url, '_blank');
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
      message.warning('请选择要删除的文件');
      return;
    }
    try {
      await fileApi.batchDelete(selectedKeys);
      message.success(`成功删除 ${selectedKeys.length} 个文件`);
      loadFiles(currentPath);
    } catch (error) {
      message.error('批量删除失败');
    }
  };

  const handleUpload = async (file: File) => {
    try {
      await fileApi.upload(file, currentPath);
      message.success(`文件 ${file.name} 上传成功`);
      loadFiles(currentPath);
    } catch (error) {
      message.error(`上传失败: ${(error as any)?.response?.data?.msg || '未知错误'}`);
    }
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
      setSelectedKeys(files.filter(f => f.type === 'file').map(f => f.key));
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
    const items = [{ title: '根目录', onClick: () => loadFiles('') }];
    if (currentPath) {
      const parts = currentPath.split('/').filter(p => p);
      let path = '';
      parts.forEach(part => {
        path += part + '/';
        items.push({ title: part, onClick: () => loadFiles(path) });
      });
    }
    return items;
  };

  const columns = [
    {
      title: (
        <Checkbox
          checked={allSelected && files.filter(f => f.type === 'file').length > 0}
          indeterminate={selectedKeys.length > 0 && !allSelected}
          onChange={toggleSelectAll}
          disabled={files.filter(f => f.type === 'file').length === 0}
        />
      ),
      key: 'checkbox',
      width: 50,
      render: (_: any, record: FileItem) => {
        if (record.type === 'directory') return null;
        return (
          <Checkbox
            checked={selectedKeys.includes(record.key)}
            onChange={() => toggleSelect(record.key)}
          />
        );
      },
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
      width: 150,
      render: (_: any, record: FileItem) => (
        <Space>
          {record.type === 'file' && (
            <>
              <Button size="small" icon={<DownloadOutlined />} onClick={() => handleDownload(record.name, record.key)}>
                下载
              </Button>
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
          <h2>文件管理</h2>
        </div>
        <Space>
          {currentPath && (
            <Button icon={<ArrowLeftOutlined />} onClick={handleBack}>
              返回上级
            </Button>
          )}
          {selectedKeys.length > 0 && (
            <Button danger icon={<DeleteOutlined />} onClick={handleBatchDelete}>
              批量删除 ({selectedKeys.length})
            </Button>
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

      <Card>
        {files.length === 0 ? (
          <Empty description="暂无文件" />
        ) : (
          <Table
            dataSource={files}
            columns={columns}
            loading={loading}
            rowKey="key"
            pagination={{ pageSize: 20 }}
          />
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
    </div>
  );
}
