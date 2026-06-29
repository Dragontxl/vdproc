import { useState, useEffect } from 'react';
import { Card, Table, Input, Button, message, Space } from 'antd';
import { EditOutlined, SaveOutlined, PlusOutlined, DeleteOutlined, CloseOutlined } from '@ant-design/icons';
import { configApi } from '../api';

interface ConfigItem {
  key: string;
  value: string;
  description: string;
  updated_at: string;
}

export default function Config() {
  const [configs, setConfigs] = useState<ConfigItem[]>([]);
  const [editingKey, setEditingKey] = useState('');
  const [editingValue, setEditingValue] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadConfigs();
  }, []);

  const loadConfigs = async () => {
    setLoading(true);
    try {
      const result = await configApi.getAll();
      setConfigs(result.data);
    } catch (error) {
      message.error('加载配置失败');
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (item: ConfigItem) => {
    setEditingKey(item.key);
    setEditingValue(item.value);
  };

  const handleSave = async (key: string) => {
    try {
      await configApi.update(key, editingValue);
      message.success('配置更新成功');
      setEditingKey('');
      loadConfigs();
    } catch (error) {
      message.error('更新配置失败');
    }
  };

  const handleDelete = async (key: string) => {
    try {
      await configApi.delete(key);
      message.success('配置删除成功');
      loadConfigs();
    } catch (error) {
      message.error('删除配置失败');
    }
  };

  const columns = [
    {
      title: '配置键',
      dataIndex: 'key',
      key: 'key',
      width: 200,
    },
    {
      title: '配置值',
      dataIndex: 'value',
      key: 'value',
      render: (value: string, record: ConfigItem) => {
        if (editingKey === record.key) {
          return (
            <Input
              value={editingValue}
              onChange={(e) => setEditingValue(e.target.value)}
              autoFocus
            />
          );
        }
        return value;
      },
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
    },
    {
      title: '更新时间',
      dataIndex: 'updated_at',
      key: 'updated_at',
      width: 150,
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: ConfigItem) => {
        if (editingKey === record.key) {
          return (
            <Space>
              <Button size="small" type="primary" icon={<SaveOutlined />} onClick={() => handleSave(record.key)}>
                保存
              </Button>
              <Button size="small" icon={<CloseOutlined />} onClick={() => setEditingKey('')}>
                取消
              </Button>
            </Space>
          );
        }
        return (
          <Space>
            <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.key)} />
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 24 }}>
        <h2>系统配置</h2>
        <Button type="primary" icon={<PlusOutlined />}>
          添加配置
        </Button>
      </div>

      <Card>
        <Table
          dataSource={configs}
          columns={columns}
          loading={loading}
          rowKey="key"
          pagination={{ pageSize: 20 }}
        />
      </Card>
    </div>
  );
}