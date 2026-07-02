import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Card, Descriptions, Tag, Timeline, Button, message } from 'antd';
import {
  PlayCircleOutlined,
  StopOutlined,
  DeleteOutlined,
  VideoCameraOutlined,
  RotateLeftOutlined,
} from '@ant-design/icons';
import { taskApi } from '../api';
import dayjs from 'dayjs';

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const [task, setTask] = useState<any>(null);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (id) {
      loadTask();
      loadLogs();
    }

    const interval = setInterval(() => {
      if (id) {
        loadTask();
        loadLogs();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [id]);

  const loadTask = async () => {
    setLoading(true);
    try {
      const result = await taskApi.get(id!);
      setTask(result.data);
    } catch (error) {
      message.error('加载任务详情失败');
    } finally {
      setLoading(false);
    }
  };

  const loadLogs = async () => {
    try {
      const response = await fetch(`/api/admin/tasks/${id}/logs`);
      const result = await response.json();
      setLogs(result.data || []);
    } catch (error) {
      console.error('Failed to load logs:', error);
    }
  };

  const handleStart = async () => {
    try {
      await taskApi.start(id!);
      message.success('任务已启动');
      loadTask();
    } catch (error) {
      message.error('启动任务失败');
    }
  };

  const handleCancel = async () => {
    try {
      await taskApi.cancel(id!);
      message.success('任务已取消');
      loadTask();
    } catch (error) {
      message.error('取消任务失败');
    }
  };

  const handleRetry = async () => {
    try {
      await taskApi.retry(id!);
      message.success('任务已重新调度');
      loadTask();
    } catch (error) {
      message.error('重试任务失败');
    }
  };

  const handleAdvancePhase = async () => {
    try {
      await taskApi.advance(id!);
      message.success('阶段已推进');
      loadTask();
    } catch (error) {
      message.error('推进阶段失败');
    }
  };

  const handleDelete = async () => {
    try {
      await taskApi.delete(id!);
      message.success('任务已删除');
      window.location.href = '/tasks';
    } catch (error) {
      message.error('删除任务失败');
    }
  };

  const getStatusTag = (status: string) => {
    const statusConfig: Record<string, { color: string; text: string }> = {
      PENDING: { color: 'default', text: '等待中' },
      EXTRACTING: { color: 'blue', text: '抽帧中' },
      EXTRACTED: { color: 'blue', text: '抽帧完成' },
      IMG2IMGING: { color: 'purple', text: '图生图中' },
      IMG2IMGED: { color: 'purple', text: '图生图完成' },
      COMPOSING: { color: 'orange', text: '合成中' },
      COMPLETED: { color: 'success', text: '已完成' },
      FAILED: { color: 'error', text: '失败' },
      CANCELLED: { color: 'default', text: '已取消' },
    };

    const config = statusConfig[status] || { color: 'default', text: status };
    return <Tag color={config.color}>{config.text}</Tag>;
  };

  const getPhaseLabel = (phase: string) => {
    const phaseMap: Record<string, string> = {
      EXTRACT: '抽帧',
      IMG2IMG: '图生图',
      COMPOSE: '合成',
    };
    return phaseMap[phase] || phase;
  };

  if (loading) {
    return <Card loading />;
  }

  if (!task) {
    return <Card>任务不存在</Card>;
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 24 }}>
        <h2>任务详情</h2>
        <div>
          {task.status === 'PENDING' && (
            <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleStart}>
              启动任务
            </Button>
          )}
          {task.status !== 'COMPLETED' && task.status !== 'CANCELLED' && (
            <Button icon={<StopOutlined />} onClick={handleCancel} style={{ marginLeft: 8 }}>
              取消任务
            </Button>
          )}
          {task.status === 'FAILED' && (
            <Button icon={<RotateLeftOutlined />} onClick={handleRetry} style={{ marginLeft: 8 }}>
              重试任务
            </Button>
          )}
          {(task.status === 'EXTRACTED' || task.status === 'IMG2IMGED') && (
            <Button type="dashed" icon={<PlayCircleOutlined />} onClick={handleAdvancePhase} style={{ marginLeft: 8 }}>
              推进阶段
            </Button>
          )}
          <Button danger icon={<DeleteOutlined />} onClick={handleDelete} style={{ marginLeft: 8 }}>
            删除任务
          </Button>
        </div>
      </div>

      <Card title="基本信息" style={{ marginBottom: 24 }}>
        <Descriptions bordered column={2}>
          <Descriptions.Item label="任务ID">{task.id}</Descriptions.Item>
          <Descriptions.Item label="标题">{task.title}</Descriptions.Item>
          <Descriptions.Item label="状态">{getStatusTag(task.status)}</Descriptions.Item>
          <Descriptions.Item label="当前阶段">{getPhaseLabel(task.current_phase || '')}</Descriptions.Item>
          <Descriptions.Item label="视频路径">{task.video_path}</Descriptions.Item>
          <Descriptions.Item label="输出视频">
            {task.final_video_url ? (
              <a href={task.final_video_url} target="_blank" rel="noopener noreferrer">
                <VideoCameraOutlined /> 查看视频
              </a>
            ) : (
              '未生成'
            )}
          </Descriptions.Item>
          <Descriptions.Item label="抽帧帧率">{task.fps} FPS</Descriptions.Item>
          <Descriptions.Item label="输出帧率">{task.output_fps} FPS</Descriptions.Item>
          <Descriptions.Item label="提示词">{task.prompt || '-'}</Descriptions.Item>
          <Descriptions.Item label="优先级">{task.priority}</Descriptions.Item>
          <Descriptions.Item label="总帧数">{task.total_frames}</Descriptions.Item>
          <Descriptions.Item label="已处理">{task.processed_frames}</Descriptions.Item>
          <Descriptions.Item label="失败帧数">{task.failed_frames}</Descriptions.Item>
          <Descriptions.Item label="重试次数">{task.retry_count}/{task.max_retries}</Descriptions.Item>
          <Descriptions.Item label="创建时间">{dayjs(task.created_at).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item>
          <Descriptions.Item label="更新时间">{dayjs(task.updated_at).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item>
          <Descriptions.Item label="开始时间">{task.started_at ? dayjs(task.started_at).format('YYYY-MM-DD HH:mm:ss') : '-'}</Descriptions.Item>
          <Descriptions.Item label="完成时间">{task.completed_at ? dayjs(task.completed_at).format('YYYY-MM-DD HH:mm:ss') : '-'}</Descriptions.Item>
          <Descriptions.Item label="错误信息" span={2}>{task.error_msg || '-'}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="任务进度">
        <Timeline>
          <Timeline.Item color={task.status === 'EXTRACTING' || task.status === 'EXTRACTED' ? 'blue' : task.status === 'COMPLETED' ? 'green' : ''}>
            抽帧阶段 {task.status === 'EXTRACTED' || task.status === 'IMG2IMGING' || task.status === 'IMG2IMGED' || task.status === 'COMPOSING' || task.status === 'COMPLETED' ? '✓' : ''}
          </Timeline.Item>
          <Timeline.Item color={task.status === 'IMG2IMGING' || task.status === 'IMG2IMGED' ? 'purple' : task.status === 'COMPLETED' ? 'green' : ''}>
            图生图阶段 {task.status === 'IMG2IMGED' || task.status === 'COMPOSING' || task.status === 'COMPLETED' ? '✓' : ''}
          </Timeline.Item>
          <Timeline.Item color={task.status === 'COMPOSING' ? 'orange' : task.status === 'COMPLETED' ? 'green' : ''}>
            合成阶段 {task.status === 'COMPLETED' ? '✓' : ''}
          </Timeline.Item>
        </Timeline>
      </Card>

      <Card title="操作日志" style={{ marginTop: 24 }}>
        {logs.length === 0 ? (
          <p>暂无日志</p>
        ) : (
          <Timeline>
            {logs.map((log: any) => (
              <Timeline.Item key={log.id} color={log.level === 'ERROR' ? 'red' : log.level === 'WARNING' ? 'orange' : 'blue'}>
                <div>
                  <strong>{log.phase}</strong> - {log.message}
                </div>
                <div style={{ color: '#999', fontSize: '12px' }}>
                  {dayjs(log.created_at).format('YYYY-MM-DD HH:mm:ss')}
                </div>
              </Timeline.Item>
            ))}
          </Timeline>
        )}
      </Card>
    </div>
  );
}