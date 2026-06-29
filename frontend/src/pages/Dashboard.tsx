import { useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Progress, Table, Tag, Button } from 'antd';
import {
  VideoCameraOutlined,
  ClockCircleOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import { taskApi } from '../api';
import dayjs from 'dayjs';

export default function Dashboard() {
  const [stats, setStats] = useState({
    total: 0,
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  });
  const [recentTasks, setRecentTasks] = useState([]);

  useEffect(() => {
    loadStats();
    loadRecentTasks();
  }, []);

  const loadStats = async () => {
    try {
      const [pending, processing, completed, failed] = await Promise.all([
        taskApi.list({ status: 'PENDING', limit: 1 }),
        taskApi.list({ status: 'EXTRACTING', limit: 1 }),
        taskApi.list({ status: 'COMPLETED', limit: 1 }),
        taskApi.list({ status: 'FAILED', limit: 1 }),
      ]);

      setStats({
        total: pending.data.length + processing.data.length + completed.data.length + failed.data.length,
        pending: pending.data.length,
        processing: processing.data.length,
        completed: completed.data.length,
        failed: failed.data.length,
      });
    } catch (error) {
      console.error('Failed to load stats:', error);
    }
  };

  const loadRecentTasks = async () => {
    try {
      const result = await taskApi.list({ page: 1, limit: 5 });
      setRecentTasks(result.data);
    } catch (error) {
      console.error('Failed to load recent tasks:', error);
    }
  };

  const getStatusTag = (status: string) => {
    const statusConfig: Record<string, { color: string; text: string; icon: React.ReactNode }> = {
      PENDING: { color: 'default', text: '等待中', icon: <ClockCircleOutlined /> },
      EXTRACTING: { color: 'blue', text: '抽帧中', icon: <PlayCircleOutlined /> },
      EXTRACTED: { color: 'blue', text: '抽帧完成', icon: <CheckCircleOutlined /> },
      IMG2IMGING: { color: 'purple', text: '图生图中', icon: <PlayCircleOutlined /> },
      IMG2IMGED: { color: 'purple', text: '图生图完成', icon: <CheckCircleOutlined /> },
      COMPOSING: { color: 'orange', text: '合成中', icon: <PlayCircleOutlined /> },
      COMPLETED: { color: 'success', text: '已完成', icon: <CheckCircleOutlined /> },
      FAILED: { color: 'error', text: '失败', icon: <CloseCircleOutlined /> },
      CANCELLED: { color: 'default', text: '已取消', icon: <CloseCircleOutlined /> },
    };

    const config = statusConfig[status] || { color: 'default', text: status, icon: null };
    return (
      <Tag color={config.color} icon={config.icon}>
        {config.text}
      </Tag>
    );
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
    },
    {
      title: '进度',
      dataIndex: ['processed_frames', 'total_frames'],
      key: 'progress',
      render: ([processed, total]: [number, number]) => (
        <Progress percent={total > 0 ? Math.round((processed / total) * 100) : 0} size="small" />
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (time: string) => dayjs(time).format('MM-DD HH:mm'),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: any) => (
        <Button size="small" onClick={() => window.location.href = `/tasks/${record.id}`}>
          详情
        </Button>
      ),
    },
  ];

  return (
    <div>
      <h2>仪表盘</h2>
      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={6}>
          <Card>
            <Statistic
              title="总任务数"
              value={stats.total}
              prefix={<VideoCameraOutlined />}
              suffix="个"
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="等待中"
              value={stats.pending}
              prefix={<ClockCircleOutlined />}
              suffix="个"
              valueStyle={{ color: '#1890ff' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="处理中"
              value={stats.processing}
              prefix={<PlayCircleOutlined />}
              suffix="个"
              valueStyle={{ color: '#722ed1' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="已完成"
              value={stats.completed}
              prefix={<CheckCircleOutlined />}
              suffix="个"
              valueStyle={{ color: '#52c41a' }}
            />
          </Card>
        </Col>
      </Row>

      <Card title="最近任务" style={{ marginBottom: 24 }}>
        <Table
          dataSource={recentTasks}
          columns={columns}
          pagination={false}
          rowKey="id"
        />
      </Card>
    </div>
  );
}