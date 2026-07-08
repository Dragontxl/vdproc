import { useState, useEffect } from 'react';
import { Card, Table, Tag, Button, Modal, Form, Input, Select, InputNumber, Space, message } from 'antd';
import {
  PlusOutlined,
  PlayCircleOutlined,
  StopOutlined,
  DeleteOutlined,
  EyeOutlined,
  RotateLeftOutlined,
  PauseCircleOutlined,
} from '@ant-design/icons';
import { taskApi } from '../api';
import dayjs from 'dayjs';

const { Option } = Select;

export default function Tasks() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    loadTasks();

    const interval = setInterval(() => {
      loadTasks();
    }, 5000);

    return () => clearInterval(interval);
  }, [statusFilter]);

  const loadTasks = async () => {
    setLoading(true);
    try {
      const result = await taskApi.list({ status: statusFilter || undefined, page: 1, limit: 100 });
      setTasks(result.data || []);
    } catch (error) {
      message.error('加载任务失败');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      await taskApi.create({
        title: values.title,
        video_path: values.videoPath,
        fps: values.fps,
        prompt: values.prompt,
        output_fps: values.outputFps,
        priority: values.priority,
      });
      message.success('任务创建成功');
      setIsModalOpen(false);
      form.resetFields();
      loadTasks();
    } catch (error) {
      message.error('创建任务失败');
    }
  };

  const handleStart = async (id: string) => {
    try {
      await taskApi.start(id);
      message.success('任务已启动');
      loadTasks();
    } catch (error) {
      message.error('启动任务失败');
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await taskApi.cancel(id);
      message.success('任务已取消');
      loadTasks();
    } catch (error) {
      message.error('取消任务失败');
    }
  };

  const handleRetry = async (id: string) => {
    try {
      await taskApi.retry(id);
      message.success('任务已重新调度');
      loadTasks();
    } catch (error) {
      message.error('重试任务失败');
    }
  };

  const handleRestartPhase = async (id: string) => {
    try {
      await taskApi.restartPhase(id);
      message.success('当前阶段已重新触发');
      loadTasks();
    } catch (error) {
      message.error('重新触发阶段失败');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await taskApi.delete(id);
      message.success('任务已删除');
      loadTasks();
    } catch (error) {
      message.error('删除任务失败');
    }
  };

  const getStatusTag = (status: string) => {
    const statusConfig: Record<string, { color: string; text: string }> = {
      PENDING: { color: 'default', text: '等待中' },
      DETECTING: { color: 'blue', text: '检测中' },
      DETECTED: { color: 'blue', text: '检测完成' },
      ANALYZING: { color: 'purple', text: '分析中' },
      ANALYZED: { color: 'purple', text: '分析完成' },
      SELECTING_FACES: { color: 'cyan', text: '选帧中' },
      FACES_SELECTED: { color: 'cyan', text: '选帧完成' },
      GENERATING_CHARACTERS: { color: 'green', text: '生人设中' },
      CHARACTERS_GENERATED: { color: 'green', text: '人设完成' },
      CROPPING_SHOTS: { color: 'orange', text: '裁切中' },
      SHOTS_CROPPED: { color: 'orange', text: '裁切完成' },
      CONVERTING_FRAMES: { color: 'red', text: '转化中' },
      FRAMES_CONVERTED: { color: 'red', text: '转化完成' },
      GENERATING_SHOTS: { color: 'pink', text: '生成分镜中' },
      SHOTS_GENERATED: { color: 'pink', text: '分镜完成' },
      COMPOSING: { color: 'yellow', text: '合成中' },
      COMPLETED: { color: 'success', text: '已完成' },
      FAILED: { color: 'error', text: '失败' },
      CANCELLED: { color: 'default', text: '已取消' },
    };

    const config = statusConfig[status] || { color: 'default', text: status };
    return <Tag color={config.color}>{config.text}</Tag>;
  };

  const columns = [
    {
      title: '任务ID',
      dataIndex: 'id',
      key: 'id',
      render: (id: string) => id.slice(0, 8),
      width: 100,
    },
    {
      title: '标题',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => getStatusTag(status),
      width: 100,
    },
    {
      title: '帧率',
      key: 'fps',
      render: (_: any, record: any) => `${record.fps || 0} -> ${record.output_fps || 0}`,
      width: 100,
    },
    {
      title: '进度',
      key: 'progress',
      render: (_: any, record: any) => {
        const processed = record.processed_frames || 0;
        const total = record.total_frames || 0;
        if (total === 0) return 'N/A';
        return `${processed}/${total} (${Math.round((processed / total) * 100)}%)`;
      },
    },
    {
      title: '重试次数',
      key: 'retry',
      render: (_: any, record: any) => `${record.retry_count || 0}/${record.max_retries || 0}`,
      width: 80,
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (time: string) => dayjs(time).format('MM-DD HH:mm'),
      width: 120,
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: any) => {
        const isRunning = ['DETECTING', 'ANALYZING', 'SELECTING_FACES', 'GENERATING_CHARACTERS', 'CROPPING_SHOTS', 'CONVERTING_FRAMES', 'GENERATING_SHOTS', 'COMPOSING'].includes(record.status);
        return (
          <Space>
            <Button size="small" icon={<EyeOutlined />} onClick={() => window.location.href = `/tasks/${record.id}`} />
            {record.status === 'PENDING' && (
              <Button size="small" icon={<PlayCircleOutlined />} onClick={() => handleStart(record.id)} />
            )}
            {record.status !== 'COMPLETED' && record.status !== 'CANCELLED' && (
              <Button size="small" icon={<StopOutlined />} onClick={() => handleCancel(record.id)} />
            )}
            {record.status === 'FAILED' && (
              <Button size="small" icon={<RotateLeftOutlined />} onClick={() => handleRetry(record.id)} />
            )}
            {isRunning && (
              <Button size="small" type="primary" icon={<PauseCircleOutlined />} onClick={() => handleRestartPhase(record.id)} />
            )}
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id)} />
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 24 }}>
        <h2>任务管理</h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setIsModalOpen(true)}>
          创建任务
        </Button>
      </div>

      <Card>
        <div style={{ marginBottom: 16, display: 'flex', gap: 16 }}>
          <Select
            placeholder="筛选状态"
            style={{ width: 150 }}
            value={statusFilter || undefined}
            onChange={(value) => setStatusFilter(value)}
          >
            <Option value="">全部</Option>
            <Option value="PENDING">等待中</Option>
            <Option value="DETECTING">检测中</Option>
            <Option value="ANALYZING">分析中</Option>
            <Option value="SELECTING_FACES">选帧中</Option>
            <Option value="GENERATING_CHARACTERS">生人设中</Option>
            <Option value="CROPPING_SHOTS">裁切中</Option>
            <Option value="CONVERTING_FRAMES">转化中</Option>
            <Option value="GENERATING_SHOTS">生成分镜中</Option>
            <Option value="COMPOSING">合成中</Option>
            <Option value="COMPLETED">已完成</Option>
            <Option value="FAILED">失败</Option>
          </Select>
        </div>
        <Table
          dataSource={tasks}
          columns={columns}
          loading={loading}
          rowKey="id"
          pagination={{ pageSize: 20 }}
        />
      </Card>

      <Modal
        title="创建任务"
        open={isModalOpen}
        onOk={handleCreate}
        onCancel={() => setIsModalOpen(false)}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="任务标题" rules={[{ required: true }]}>
            <Input placeholder="请输入任务标题" />
          </Form.Item>
          <Form.Item name="videoPath" label="视频路径" rules={[{ required: true }]}>
            <Input placeholder="R2存储中的视频路径" />
          </Form.Item>
          <Form.Item name="prompt" label="提示词">
            <Input.TextArea placeholder="AI生成提示词" rows={3} />
          </Form.Item>
          <Form.Item name="fps" label="抽帧帧率" initialValue={30}>
            <InputNumber min={1} max={120} />
          </Form.Item>
          <Form.Item name="outputFps" label="输出帧率" initialValue={30}>
            <InputNumber min={1} max={120} />
          </Form.Item>
          <Form.Item name="priority" label="优先级" initialValue={0}>
            <InputNumber min={0} max={100} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}