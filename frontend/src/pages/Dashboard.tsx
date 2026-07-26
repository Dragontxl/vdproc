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
import 'dayjs/plugin/utc';

const dayjsUtc = (time: string) => dayjs.utc(time).local();

const phaseStatusMap: Record<string, string> = {
  DETECT: 'DETECTING',
  ANALYZE: 'ANALYZING',
  CROP_SHOTS: 'CROPPING_SHOTS',
  CONVERT_FRAMES: 'CONVERTING_FRAMES',
  GENERATE_SHOTS: 'GENERATING_SHOTS',
  COMPOSE: 'COMPOSING',
};

const terminalStatuses = ['COMPLETED', 'FAILED', 'CANCELLED', 'PENDING'];

const getDerivedStatus = (task: any): string => {
  if (!task) return 'PENDING';
  if (terminalStatuses.includes(task.status)) {
    return task.status;
  }
  return phaseStatusMap[task.current_phase] || task.status || 'PENDING';
};

const isProcessingStatus = (status: string): boolean => {
  return [
    'DETECTING', 'DETECTED',
    'ANALYZING', 'ANALYZED',
    'CROPPING_SHOTS', 'SHOTS_CROPPED',
    'CONVERTING_FRAMES', 'FRAMES_CONVERTED',
    'GENERATING_SHOTS', 'SHOTS_GENERATED',
    'COMPOSING',
  ].includes(status);
};

const isPendingStatus = (status: string): boolean => {
  return status === 'PENDING';
};

const isCompletedStatus = (status: string): boolean => {
  return status === 'COMPLETED';
};

const isFailedStatus = (status: string): boolean => {
  return status === 'FAILED';
};

export default function Dashboard() {
  const [stats, setStats] = useState({
    total: 0,
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  });
  const [recentTasks, setRecentTasks] = useState([]);

  const computeStats = (tasks: any[]) => {
    let pending = 0, processing = 0, completed = 0, failed = 0;
    for (const task of tasks) {
      const derived = getDerivedStatus(task);
      if (isPendingStatus(derived)) pending++;
      else if (isProcessingStatus(derived)) processing++;
      else if (isCompletedStatus(derived)) completed++;
      else if (isFailedStatus(derived)) failed++;
    }
    return {
      total: tasks.length,
      pending,
      processing,
      completed,
      failed,
    };
  };

  useEffect(() => {
    const loadAll = async () => {
      try {
        const result = await taskApi.list({ page: 1, limit: 1000 });
        const tasks = result.data || [];
        setStats(computeStats(tasks));
        setRecentTasks(tasks.slice(0, 5));
      } catch (error) {
        console.error('Failed to load dashboard data:', error);
      }
    };

    loadAll();
    const interval = setInterval(loadAll, 10000);
    return () => clearInterval(interval);
  }, []);

  const getStatusTag = (status: string) => {
    const statusConfig: Record<string, { color: string; text: string; icon: React.ReactNode }> = {
      PENDING: { color: 'default', text: '等待中', icon: <ClockCircleOutlined /> },
      DETECTING: { color: 'blue', text: '检测中', icon: <PlayCircleOutlined /> },
      DETECTED: { color: 'blue', text: '检测完成', icon: <CheckCircleOutlined /> },
      ANALYZING: { color: 'purple', text: '分析中', icon: <PlayCircleOutlined /> },
      ANALYZED: { color: 'purple', text: '分析完成', icon: <CheckCircleOutlined /> },
      CROPPING_SHOTS: { color: 'orange', text: '裁切中', icon: <PlayCircleOutlined /> },
      SHOTS_CROPPED: { color: 'orange', text: '裁切完成', icon: <CheckCircleOutlined /> },
      CONVERTING_FRAMES: { color: 'red', text: '转化中', icon: <PlayCircleOutlined /> },
      FRAMES_CONVERTED: { color: 'red', text: '转化完成', icon: <CheckCircleOutlined /> },
      GENERATING_SHOTS: { color: 'pink', text: '分镜生成中', icon: <PlayCircleOutlined /> },
      SHOTS_GENERATED: { color: 'pink', text: '分镜完成', icon: <CheckCircleOutlined /> },
      COMPOSING: { color: 'yellow', text: '合成中', icon: <PlayCircleOutlined /> },
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
      render: (_: string, record: any) => getStatusTag(getDerivedStatus(record)),
    },
    {
      title: '进度',
      key: 'progress',
      render: (_: any, record: any) => {
        const processed = record.processed_frames || 0;
        const total = record.total_frames || 0;
        return <Progress percent={total > 0 ? Math.round((processed / total) * 100) : 0} size="small" />;
      },
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (time: string) => dayjsUtc(time).format('MM-DD HH:mm'),
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
