import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Card, Descriptions, Tag, Timeline, Button, message, Space, Row, Col, Divider, Alert, Progress, Select, Table, Popconfirm, Input } from 'antd';
import {
  PlayCircleOutlined,
  StopOutlined,
  DeleteOutlined,
  VideoCameraOutlined,
  RotateLeftOutlined,
  PauseCircleOutlined,
  CheckCircleOutlined,
  RocketOutlined,
  ReloadOutlined,
  EyeOutlined,
} from '@ant-design/icons';
import { taskApi } from '../api';
import dayjs from 'dayjs';

const { Option } = Select;

type TaskPhase = 'DETECT' | 'ANALYZE' | 'SELECT_FACES' | 'GENERATE_CHARACTERS' | 'CROP_SHOTS' | 'CONVERT_FRAMES' | 'GENERATE_SHOTS' | 'COMPOSE';

const phaseConfig: Record<TaskPhase, { label: string; description: string; icon: React.ReactNode }> = {
  DETECT: { label: '镜头检测', description: '使用PySceneDetect检测视频镜头边界', icon: <VideoCameraOutlined /> },
  ANALYZE: { label: '剧情分析', description: '使用Gemini分析剧情并生成分镜详情', icon: <RocketOutlined /> },
  SELECT_FACES: { label: '最优帧选择', description: '筛选每个角色的最优正脸帧', icon: <CheckCircleOutlined /> },
  GENERATE_CHARACTERS: { label: '人设图生成', description: '生成动画风格角色人设图', icon: <PlayCircleOutlined /> },
  CROP_SHOTS: { label: '分镜裁切', description: '裁切分镜片段并抽取首尾帧', icon: <VideoCameraOutlined /> },
  CONVERT_FRAMES: { label: '首尾帧转化', description: '将首尾帧转化为动画风格', icon: <PlayCircleOutlined /> },
  GENERATE_SHOTS: { label: '分镜生成', description: '生成完整分镜视频片段', icon: <PlayCircleOutlined /> },
  COMPOSE: { label: '视频合成', description: '合成分镜片段为完整视频', icon: <VideoCameraOutlined /> },
};

const statusConfig: Record<string, { color: string; text: string }> = {
  PENDING: { color: 'default', text: '等待中' },
  DETECTING: { color: 'blue', text: '镜头检测中' },
  DETECTED: { color: 'blue', text: '镜头检测完成' },
  ANALYZING: { color: 'purple', text: '剧情分析中' },
  ANALYZED: { color: 'purple', text: '剧情分析完成' },
  SELECTING_FACES: { color: 'cyan', text: '最优帧选择中' },
  FACES_SELECTED: { color: 'cyan', text: '最优帧选择完成' },
  GENERATING_CHARACTERS: { color: 'green', text: '人设图生成中' },
  CHARACTERS_GENERATED: { color: 'green', text: '人设图生成完成' },
  CROPPING_SHOTS: { color: 'orange', text: '分镜裁切中' },
  SHOTS_CROPPED: { color: 'orange', text: '分镜裁切完成' },
  CONVERTING_FRAMES: { color: 'red', text: '首尾帧转化中' },
  FRAMES_CONVERTED: { color: 'red', text: '首尾帧转化完成' },
  GENERATING_SHOTS: { color: 'pink', text: '分镜生成中' },
  SHOTS_GENERATED: { color: 'pink', text: '分镜生成完成' },
  COMPOSING: { color: 'yellow', text: '合成中' },
  COMPLETED: { color: 'success', text: '已完成' },
  FAILED: { color: 'error', text: '失败' },
  CANCELLED: { color: 'default', text: '已取消' },
};

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const [task, setTask] = useState<any>(null);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [phaseStatus, setPhaseStatus] = useState<Record<string, { ready: boolean; missing: string[]; available: string[] }>>({});
  const [startPhaseValue, setStartPhaseValue] = useState<TaskPhase>('DETECT');
  const [endPhaseValue, setEndPhaseValue] = useState<TaskPhase>('COMPOSE');
  const [subtasks, setSubtasks] = useState<any[]>([]);
  const [selectedSubtaskPhase, setSelectedSubtaskPhase] = useState<TaskPhase | ''>('');
  const [subtaskLoading, setSubtaskLoading] = useState(false);
  const [customPrompts, setCustomPrompts] = useState<Record<string, string>>({});
  
  const subtaskPhases: TaskPhase[] = ['GENERATE_CHARACTERS', 'CONVERT_FRAMES', 'GENERATE_SHOTS'];
  const allPhases: TaskPhase[] = ['DETECT', 'ANALYZE', 'SELECT_FACES', 'GENERATE_CHARACTERS', 'CROP_SHOTS', 'CONVERT_FRAMES', 'GENERATE_SHOTS', 'COMPOSE'];

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
    }, 30000);

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

  const loadSubtasks = async (phase?: TaskPhase) => {
    setSubtaskLoading(true);
    try {
      const result = await taskApi.getSubtasks(id!, phase);
      const list = result.data || [];
      setSubtasks(list);
      if (phase) {
        setSelectedSubtaskPhase(phase);
      }
      // 以每个子任务的 original_prompt 作为自定义提示词框的默认值（仅在用户未编辑过该 key 时填充）
      setCustomPrompts((prev) => {
        const next = { ...prev };
        for (const item of list as any[]) {
          const key = `${item.phase}-${item.subtask_index}`;
          if (next[key] === undefined && item.original_prompt) {
            next[key] = item.original_prompt;
          }
        }
        return next;
      });
    } catch (error: any) {
      const msg = error.response?.data?.msg || '加载子任务失败';
      message.error(msg);
    } finally {
      setSubtaskLoading(false);
    }
  };

  const handleRunSubtask = async (phase: string, index: number) => {
    try {
      const key = `${phase}-${index}`;
      const customPrompt = customPrompts[key]?.trim();
      const body = customPrompt ? { custom_prompt: customPrompt } : undefined;
      await taskApi.runSubtask(id!, phase, index, body);
      message.success('子任务已启动');
      loadSubtasks(selectedSubtaskPhase as TaskPhase);
    } catch (error: any) {
      const msg = error.response?.data?.msg || '启动子任务失败';
      message.error(msg);
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

  const handleRestartPhase = async () => {
    try {
      await taskApi.restartPhase(id!);
      message.success('当前阶段已重新触发');
      loadTask();
    } catch (error) {
      message.error('重新触发阶段失败');
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

  const checkPhase = async (phase: TaskPhase) => {
    try {
      const result = await taskApi.checkPhase(id!, phase);
      setPhaseStatus(prev => ({ ...prev, [phase]: result.data }));
    } catch (error) {
      message.error('检查素材失败');
    }
  };

  const startPhase = async (phase: TaskPhase, useRange: boolean = false) => {
    try {
      const options = useRange ? { start_phase: startPhaseValue, end_phase: endPhaseValue } : undefined;
      await taskApi.startPhase(id!, phase, options);
      const msg = useRange 
        ? `${phaseConfig[startPhaseValue].label}到${phaseConfig[endPhaseValue].label}启动成功`
        : `${phaseConfig[phase].label}启动成功`;
      message.success(msg);
      loadTask();
    } catch (error: any) {
      const msg = error.response?.data?.msg || '启动阶段失败';
      message.error(msg);
    }
  };

  const getStatusTag = (status: string) => {
    const config = statusConfig[status] || { color: 'default', text: status };
    return <Tag color={config.color}>{config.text}</Tag>;
  };

  const getPhaseStatusColor = (phase: TaskPhase) => {
    const status = task?.status || '';
    const currentPhase = task?.current_phase || '';
    
    const runningStatus = `${phase}ING`;
    const doneStatus = `${phase}ED`;
    
    if (status === runningStatus) return 'processing';
    if (status === doneStatus || (currentPhase !== phase && isPhaseCompleted(currentPhase))) return 'success';
    if (status === 'COMPLETED') return 'success';
    return 'default';
  };

  const isPhaseCompleted = (currentPhase: string): boolean => {
    const phases: TaskPhase[] = ['GENERATE_CHARACTERS', 'CONVERT_FRAMES', 'GENERATE_SHOTS'];
    const currentIndex = phases.indexOf(currentPhase as TaskPhase);
    return currentIndex > -1;
  };

  const isPhaseRunning = () => {
    const runningStatuses = ['DETECTING', 'ANALYZING', 'SELECTING_FACES', 'GENERATING_CHARACTERS', 'CROPPING_SHOTS', 'CONVERTING_FRAMES', 'GENERATING_SHOTS', 'COMPOSING'];
    return runningStatuses.includes(task?.status || '');
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
          {isPhaseRunning() && (
            <Button type="primary" icon={<PauseCircleOutlined />} onClick={handleRestartPhase} style={{ marginLeft: 8 }}>
              继续任务
            </Button>
          )}
          <Button danger icon={<DeleteOutlined />} onClick={handleDelete} style={{ marginLeft: 8 }}>
            删除任务
          </Button>
        </div>
      </div>

      <Card title="基本信息" style={{ marginBottom: 24 }}>
        {task.status_message && (
          <Alert
            message={task.status_message}
            type={task.status === 'FAILED' ? 'error' : 'info'}
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}
        {task.progress > 0 && task.status !== 'COMPLETED' && task.status !== 'FAILED' && (
          <Progress percent={task.progress} status="active" style={{ marginBottom: 16 }} />
        )}
        <Descriptions bordered column={2}>
          <Descriptions.Item label="任务ID">{task.id}</Descriptions.Item>
          <Descriptions.Item label="标题">{task.title}</Descriptions.Item>
          <Descriptions.Item label="状态">{getStatusTag(task.status)}</Descriptions.Item>
          <Descriptions.Item label="当前阶段">
            {phaseConfig[task.current_phase as TaskPhase]?.label || task.current_phase || '-'}
          </Descriptions.Item>
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

      <Card title="阶段控制" style={{ marginBottom: 24 }}>
        <div style={{ marginBottom: 16, padding: '12px', background: '#f5f5f5', borderRadius: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <span style={{ fontWeight: 'bold' }}>阶段范围执行：</span>
            <Select
              value={startPhaseValue}
              onChange={(value) => setStartPhaseValue(value as TaskPhase)}
              style={{ width: 160 }}
              disabled={isPhaseRunning()}
            >
              {allPhases.map((p) => (
                <Option key={p} value={p}>{phaseConfig[p].label}</Option>
              ))}
            </Select>
            <span>→</span>
            <Select
              value={endPhaseValue}
              onChange={(value) => setEndPhaseValue(value as TaskPhase)}
              style={{ width: 160 }}
              disabled={isPhaseRunning()}
            >
              {allPhases.map((p) => (
                <Option key={p} value={p}>{phaseConfig[p].label}</Option>
              ))}
            </Select>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={() => startPhase(startPhaseValue, true)}
              disabled={isPhaseRunning() || allPhases.indexOf(startPhaseValue) > allPhases.indexOf(endPhaseValue)}
            >
              执行范围
            </Button>
            {allPhases.indexOf(startPhaseValue) > allPhases.indexOf(endPhaseValue) && (
              <span style={{ color: '#ff4d4f', fontSize: '12px' }}>起始阶段不能晚于结束阶段</span>
            )}
          </div>
        </div>
        
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {(['DETECT', 'ANALYZE', 'SELECT_FACES', 'GENERATE_CHARACTERS', 'CROP_SHOTS', 'CONVERT_FRAMES', 'GENERATE_SHOTS', 'COMPOSE'] as TaskPhase[]).map((phase) => {
            const config = phaseConfig[phase];
            const statusColor = getPhaseStatusColor(phase);
            const phaseState = phaseStatus[phase];

            return (
              <div key={phase} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', border: '1px solid #f0f0f0', borderRadius: '8px' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {statusColor === 'success' && <CheckCircleOutlined style={{ color: '#52c41a' }} />}
                    {statusColor === 'processing' && <PlayCircleOutlined style={{ color: '#1890ff' }} />}
                    <Tag color={statusColor === 'success' ? 'success' : statusColor === 'processing' ? 'blue' : 'default'}>
                      {config.label}
                    </Tag>
                  </div>
                  <div style={{ color: '#999', fontSize: '12px', marginTop: '4px' }}>
                    {config.description}
                  </div>
                  {phaseState && (
                    <div style={{ marginTop: '8px' }}>
                      {phaseState.ready ? (
                        <span style={{ color: '#52c41a', fontSize: '12px' }}>
                          ✓ 素材齐全
                        </span>
                      ) : (
                        <span style={{ color: '#ff4d4f', fontSize: '12px' }}>
                          ✗ 缺少素材: {phaseState.missing.join(', ')}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <Button size="small" onClick={() => checkPhase(phase)}>
                    检查素材
                  </Button>
                  <Button
                    type="primary"
                    size="small"
                    onClick={() => startPhase(phase)}
                    disabled={isPhaseRunning()}
                  >
                    单独启动
                  </Button>
                </div>
              </div>
            );
          })}
        </Space>
      </Card>

      <Card title="任务进度">
        <Timeline>
          {(['DETECT', 'ANALYZE', 'SELECT_FACES', 'GENERATE_CHARACTERS', 'CROP_SHOTS', 'CONVERT_FRAMES', 'GENERATE_SHOTS', 'COMPOSE'] as TaskPhase[]).map((phase) => {
            const config = phaseConfig[phase];
            const status = task?.status || '';
            const isRunning = status === `${phase}ING`;
            const isDone = status === `${phase}ED` || status === 'COMPLETED';
            const color = isRunning ? 'blue' : isDone ? 'green' : '';
            
            return (
              <Timeline.Item key={phase} color={color}>
                {config.label} {isDone ? '✓' : isRunning ? '处理中...' : ''}
              </Timeline.Item>
            );
          })}
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

      <Card title="子任务管理" style={{ marginTop: 24 }}>
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontWeight: 'bold' }}>选择阶段查看子任务：</span>
          <Select
            value={selectedSubtaskPhase || undefined}
            onChange={(value) => {
              setSelectedSubtaskPhase(value as TaskPhase);
              if (value) {
                loadSubtasks(value as TaskPhase);
              } else {
                setSubtasks([]);
              }
            }}
            style={{ width: 160 }}
            placeholder="全部阶段"
          >
            {subtaskPhases.map((p) => (
              <Option key={p} value={p}>{phaseConfig[p].label}</Option>
            ))}
          </Select>
          <Button type="primary" onClick={() => loadSubtasks(selectedSubtaskPhase as TaskPhase)} disabled={!selectedSubtaskPhase}>
            刷新
          </Button>
        </div>

        {subtasks.length === 0 ? (
          <p>{selectedSubtaskPhase ? '该阶段暂无子任务' : '请选择阶段查看子任务'}</p>
        ) : (
          <Table
            dataSource={subtasks}
            rowKey={(record) => `${record.phase}-${record.subtask_index}`}
            loading={subtaskLoading}
            pagination={{ pageSize: 10 }}
          >
            <Table.Column
              title="阶段"
              dataIndex="phase"
              key="phase"
              render={(phase) => <Tag color="blue">{phaseConfig[phase as TaskPhase]?.label || phase}</Tag>}
            />
            <Table.Column
              title="子任务索引"
              dataIndex="subtask_index"
              key="subtask_index"
            />
            <Table.Column
              title="类型"
              dataIndex="subtask_type"
              key="subtask_type"
              render={(type) => <Tag>{type}</Tag>}
            />
            <Table.Column
              title="状态"
              dataIndex="status"
              key="status"
              render={(status) => (
                <Tag color={
                  status === 'COMPLETED' ? 'green' :
                  status === 'PROCESSING' ? 'blue' :
                  status === 'FAILED' ? 'red' : 'default'
                }>
                  {status === 'COMPLETED' ? '已完成' :
                   status === 'PROCESSING' ? '处理中' :
                   status === 'FAILED' ? '失败' : '等待中'}
                </Tag>
              )}
            />
            <Table.Column
              title="输入路径"
              dataIndex="input_path"
              key="input_path"
              ellipsis
              width={300}
            />
            <Table.Column
              title="输出路径"
              dataIndex="output_path"
              key="output_path"
              ellipsis
              width={300}
            />
            <Table.Column
              title="重试次数"
              dataIndex="retry_count"
              key="retry_count"
              render={(retry, record) => `${retry}/${record.max_retries || 3}`}
            />
            <Table.Column
              title="错误信息"
              dataIndex="error_msg"
              key="error_msg"
              ellipsis
              width={200}
            />
            <Table.Column
              title="自定义提示词"
              dataIndex="custom_prompt"
              key="custom_prompt"
              width={250}
              render={(_, record) => {
                const key = `${record.phase}-${record.subtask_index}`;
                return (
                  <Input.TextArea
                    placeholder="输入自定义提示词，留空使用默认"
                    value={customPrompts[key] || ''}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setCustomPrompts(prev => ({ ...prev, [key]: e.target.value }))}
                    autoSize={{ minRows: 2, maxRows: 4 }}
                  />
                );
              }}
            />
            <Table.Column
              title="操作"
              key="actions"
              render={(_, record) => (
                <Space>
                  <Button
                    type="primary"
                    size="small"
                    icon={<ReloadOutlined />}
                    onClick={() => handleRunSubtask(record.phase, record.subtask_index)}
                    disabled={record.status === 'PROCESSING'}
                  >
                    {record.status === 'PROCESSING' ? '处理中' : '运行'}
                  </Button>
                </Space>
              )}
            />
          </Table>
        )}
      </Card>
    </div>
  );
}