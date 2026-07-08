import { useState, useEffect } from 'react';
import { Card, Table, Tag, Button, Modal, Form, Input, InputNumber, Switch, Space, message, Tabs, Select } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined, HeartOutlined } from '@ant-design/icons';
import { accountApi } from '../api';
import dayjs from 'dayjs';

const { TabPane } = Tabs;

export default function Accounts() {
  const [githubAccounts, setGithubAccounts] = useState([]);
  const [aiAccounts, setAiAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [currentAccount, setCurrentAccount] = useState<any>(null);
  const [accountType, setAccountType] = useState<'github' | 'ai'>('github');
  const [form] = Form.useForm();

  const loadAccounts = async () => {
    setLoading(true);
    try {
      const [ghResult, aiResult] = await Promise.all([
        accountApi.listGitHub(),
        accountApi.listAI(),
      ]);
      setGithubAccounts(ghResult.data || []);
      setAiAccounts(aiResult.data || []);
    } catch (error) {
      message.error('加载账户失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAccounts();
  }, []);

  const handleAdd = () => {
    setEditMode(false);
    setCurrentAccount(null);
    form.resetFields();
    setIsModalOpen(true);
  };

  const handleEdit = (account: any, type: 'github' | 'ai') => {
    setEditMode(true);
    setCurrentAccount(account);
    setAccountType(type);
    form.setFieldsValue(account);
    setIsModalOpen(true);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();

      if (editMode) {
        if (accountType === 'github') {
          await accountApi.updateGitHub(currentAccount.id, values);
        } else {
          await accountApi.updateAI(currentAccount.id, values);
        }
        message.success('账户更新成功');
      } else {
        if (accountType === 'github') {
          await accountApi.createGitHub(values);
        } else {
          await accountApi.createAI(values);
        }
        message.success('账户创建成功');
      }

      setIsModalOpen(false);
      loadAccounts();
    } catch (error) {
      message.error('保存账户失败');
    }
  };

  const handleDelete = async (id: number, type: 'github' | 'ai') => {
    try {
      if (type === 'github') {
        await accountApi.deleteGitHub(id);
      } else {
        await accountApi.deleteAI(id);
      }
      message.success('账户删除成功');
      loadAccounts();
    } catch (error) {
      message.error('删除账户失败');
    }
  };

  const handleHealthCheck = async (id: number) => {
    try {
      await accountApi.checkAIHealth(id);
      message.success('健康检查完成');
      loadAccounts();
    } catch (error) {
      message.error('健康检查失败');
    }
  };

  const githubColumns = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: '用户名',
      dataIndex: 'username',
      key: 'username',
    },
    {
      title: '月使用/限制',
      key: 'usage',
      render: (_: any, record: any) => `${record.monthly_used_minutes || 0}/${record.monthly_limit || 0} 分钟`,
    },
    {
      title: '状态',
      dataIndex: 'is_active',
      key: 'is_active',
      render: (active: boolean) => <Tag color={active ? 'success' : 'default'}>{active ? '活跃' : '禁用'}</Tag>,
    },
    {
      title: '是否受限',
      dataIndex: 'is_limited',
      key: 'is_limited',
      render: (limited: boolean) => <Tag color={limited ? 'error' : 'success'}>{limited ? '受限' : '正常'}</Tag>,
    },
    {
      title: '成功率',
      dataIndex: 'success_rate',
      key: 'success_rate',
      render: (rate: number) => `${rate}%`,
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (time: string) => dayjs(time).format('MM-DD'),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: any) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(record, 'github')} />
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id, 'github')} />
        </Space>
      ),
    },
  ];

  const aiColumns = [
    {
      title: '别名',
      dataIndex: 'account_alias',
      key: 'account_alias',
    },
    {
      title: '类型',
      dataIndex: 'api_type',
      key: 'api_type',
      render: (type: string) => <Tag color={type === 'text' ? 'blue' : type === 'image' ? 'green' : 'purple'}>
        {type === 'text' ? '文本' : type === 'image' ? '图像' : '视频'}
      </Tag>,
    },
    {
      title: '模型',
      dataIndex: 'model_name',
      key: 'model_name',
    },
    {
      title: '日使用/限制',
      key: 'usage',
      render: (_: any, record: any) => `${record.daily_usage || 0}/${record.daily_limit || 0} 次`,
    },
    {
      title: '优先级',
      dataIndex: 'priority_weight',
      key: 'priority_weight',
    },
    {
      title: '状态',
      dataIndex: 'is_active',
      key: 'is_active',
      render: (active: boolean) => <Tag color={active ? 'success' : 'default'}>{active ? '活跃' : '禁用'}</Tag>,
    },
    {
      title: '健康状态',
      dataIndex: 'is_healthy',
      key: 'is_healthy',
      render: (healthy: boolean) => <Tag color={healthy ? 'success' : 'error'}>{healthy ? '健康' : '异常'}</Tag>,
    },
    {
      title: '成功率',
      dataIndex: 'success_rate',
      key: 'success_rate',
      render: (rate: number) => `${rate}%`,
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (time: string) => dayjs(time).format('MM-DD'),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: any) => (
        <Space>
          <Button size="small" icon={<HeartOutlined />} onClick={() => handleHealthCheck(record.id)} />
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(record, 'ai')} />
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id, 'ai')} />
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 24 }}>
        <h2>账户管理</h2>
      </div>

      <Tabs defaultActiveKey="github">
        <TabPane tab="GitHub 账户" key="github">
          <Card>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setAccountType('github'); handleAdd(); }} style={{ marginBottom: 16 }}>
              添加 GitHub 账户
            </Button>
            <Table
              dataSource={githubAccounts}
              columns={githubColumns}
              loading={loading}
              rowKey="id"
              pagination={{ pageSize: 10 }}
            />
          </Card>
        </TabPane>
        <TabPane tab="AI 账户" key="ai">
          <Card>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setAccountType('ai'); handleAdd(); }} style={{ marginBottom: 16 }}>
              添加 AI 账户
            </Button>
            <Table
              dataSource={aiAccounts}
              columns={aiColumns}
              loading={loading}
              rowKey="id"
              pagination={{ pageSize: 10 }}
            />
          </Card>
        </TabPane>
      </Tabs>

      <Modal
        title={editMode ? `${accountType === 'github' ? '编辑 GitHub' : '编辑 AI'} 账户` : `${accountType === 'github' ? '添加 GitHub' : '添加 AI'} 账户`}
        open={isModalOpen}
        onOk={handleSave}
        onCancel={() => setIsModalOpen(false)}
      >
        <Form form={form} layout="vertical">
          {accountType === 'github' ? (
            <>
              <Form.Item name="name" label="账户名称" rules={[{ required: true }]}>
                <Input placeholder="请输入账户名称" />
              </Form.Item>
              <Form.Item name="username" label="GitHub 用户名">
                <Input placeholder="请输入 GitHub 用户名" />
              </Form.Item>
              <Form.Item name="token_encrypted" label="API Token（加密）" rules={[{ required: true }]}>
                <Input.Password placeholder="请输入加密后的 API Token" />
              </Form.Item>
              <Form.Item name="monthly_limit" label="月度限额（分钟）" initialValue={2000}>
                <InputNumber min={0} />
              </Form.Item>
              <Form.Item name="is_active" label="是否活跃" initialValue={true}>
                <Switch />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item name="account_alias" label="账户别名" rules={[{ required: true }]}>
                <Input placeholder="请输入账户别名" />
              </Form.Item>
              <Form.Item name="api_type" label="API 类型" rules={[{ required: true }]} initialValue="image">
                <Select>
                  <Select.Option value="text">文本模型（如 Gemini）</Select.Option>
                  <Select.Option value="image">图像模型（如图生图）</Select.Option>
                  <Select.Option value="video">视频模型（如视频生成）</Select.Option>
                </Select>
              </Form.Item>
              <Form.Item name="api_key_encrypted" label="API Key（加密）" rules={[{ required: true }]}>
                <Input.Password placeholder="请输入加密后的 API Key" />
              </Form.Item>
              <Form.Item name="base_url" label="API 地址" initialValue="https://apihub.agnes-ai.com/v1/images/generations">
                <Input placeholder="请输入 API 地址" />
              </Form.Item>
              <Form.Item name="model_name" label="模型名称" initialValue="agnes-image-2.1-flash">
                <Input placeholder="请输入模型名称" />
              </Form.Item>
              <Form.Item name="priority_weight" label="优先级权重" initialValue={50}>
                <InputNumber min={0} max={100} />
              </Form.Item>
              <Form.Item name="max_concurrent" label="最大并发数" initialValue={1}>
                <InputNumber min={1} />
              </Form.Item>
              <Form.Item name="daily_limit" label="日限额" initialValue={1000}>
                <InputNumber min={0} />
              </Form.Item>
              <Form.Item name="is_active" label="是否活跃" initialValue={true}>
                <Switch />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </div>
  );
}