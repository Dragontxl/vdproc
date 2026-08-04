import { useState, useEffect, useRef } from 'react';
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
  CopyOutlined,
  DownloadOutlined,
  UploadOutlined,
  FileImageOutlined,
} from '@ant-design/icons';
import { taskApi, fileApi } from '../api';
import dayjs from 'dayjs';
import 'dayjs/plugin/utc';

const dayjsUtc = (time: string) => dayjs.utc(time).local();
import FileBrowser from './FileBrowser';

const { Option } = Select;

type TaskPhase = 'DETECT' | 'ANALYZE' | 'CROP_SHOTS' | 'CONVERT_FRAMES' | 'GENERATE_SHOTS' | 'COMPOSE';

const phaseConfig: Record<TaskPhase, { label: string; description: string; icon: React.ReactNode }> = {
  DETECT: { label: '镜头检测', description: '使用PySceneDetect检测视频镜头边界', icon: <VideoCameraOutlined /> },
  ANALYZE: { label: '剧情分析', description: '使用Gemini分析剧情并生成分镜详情', icon: <RocketOutlined /> },
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
  const [phaseStatus, setPhaseStatus] = useState<Record<string, { ready: boolean; missing: string[]; available: string[] }>>({});
  const [startPhaseValue, setStartPhaseValue] = useState<TaskPhase>('DETECT');
  const [endPhaseValue, setEndPhaseValue] = useState<TaskPhase>('COMPOSE');
  const [subtasks, setSubtasks] = useState<any[]>([]);
  const [selectedSubtaskPhase, setSelectedSubtaskPhase] = useState<TaskPhase | ''>('');
  const [subtaskLoading, setSubtaskLoading] = useState(false);
  const [customPrompts, setCustomPrompts] = useState<Record<string, string>>({});
  const [selectedSubtaskKeys, setSelectedSubtaskKeys] = useState<React.Key[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  // 跟踪用户手动编辑过的提示词 key，这些 key 的值不会被 original_prompt 覆盖
  const userEditedPromptKeys = useRef<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollPositionRef = useRef({ x: 0, y: 0 });
  // 隐藏的 file input ref，用于上传帧和视频
  const uploadFrameInputRef = useRef<HTMLInputElement>(null);
  const uploadVideoInputRef = useRef<HTMLInputElement>(null);
  // 记录当前操作的子任务索引（用于上传时确定目标路径）
  const currentUploadSubtaskRef = useRef<{ phase: string; index: number } | null>(null);
  
  const subtaskPhases: TaskPhase[] = ['CONVERT_FRAMES', 'GENERATE_SHOTS'];
  const allPhases: TaskPhase[] = ['DETECT', 'ANALYZE', 'CROP_SHOTS', 'CONVERT_FRAMES', 'GENERATE_SHOTS', 'COMPOSE'];

  useEffect(() => {
    if (id) {
      loadTask(true);
      loadLogs();
    }

    const interval = setInterval(() => {
      if (id) {
        saveScrollPosition();
        loadTask(false);
        loadLogs();
        restoreScrollPosition();
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [id]);

  const saveScrollPosition = () => {
    if (containerRef.current) {
      scrollPositionRef.current = {
        x: containerRef.current.scrollLeft,
        y: containerRef.current.scrollTop,
      };
    } else {
      scrollPositionRef.current = {
        x: window.scrollX,
        y: window.scrollY,
      };
    }
  };

  const restoreScrollPosition = () => {
    setTimeout(() => {
      if (containerRef.current) {
        containerRef.current.scrollLeft = scrollPositionRef.current.x;
        containerRef.current.scrollTop = scrollPositionRef.current.y;
      } else {
        window.scrollTo(scrollPositionRef.current.x, scrollPositionRef.current.y);
      }
    }, 50);
  };

  const loadTask = async (showLoading: boolean = false) => {
    try {
      const result = await taskApi.get(id!);
      const newData = result.data;
      
      setTask((prev: any) => {
        if (!prev) {
          return newData;
        }
        
        const changedFields: string[] = [];
        for (const key of Object.keys(newData)) {
          if (JSON.stringify(prev[key]) !== JSON.stringify(newData[key])) {
            changedFields.push(key);
          }
        }
        
        if (changedFields.length === 0) {
          return prev;
        }
        
        return newData;
      });
    } catch (error) {
      console.error('加载任务详情失败:', error);
    }
  };

  const loadLogs = async () => {
    try {
      const backendUrl = import.meta.env.VITE_BACKEND_URL || 'https://ai-video.ldragon.xyz';
      const response = await fetch(`${backendUrl}/api/v1/admin/tasks/${id}/logs`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
      });
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
      // 以每个子任务的 original_prompt 作为自定义提示词框的默认值
      // 每次加载时用最新的 original_prompt 同步，但保留用户手动编辑过的值
      // 这样可以避免 analysis_result.json 更新后提示词与分镜数据错位
      setCustomPrompts((prev) => {
        const next = { ...prev };
        for (const item of list as any[]) {
          const key = `${item.phase}-${item.subtask_index}`;
          // 只更新用户未手动编辑过的 key
          if (!userEditedPromptKeys.current.has(key) && item.original_prompt) {
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

  const handleRefreshSubtasks = async () => {
    setSubtaskLoading(true);
    console.log('handleRefreshSubtasks called, taskId:', id);
    try {
      const cleanupResult: any = await taskApi.cleanupStaleSubtasks(id!);
      console.log('cleanupStaleSubtasks result:', JSON.stringify(cleanupResult, null, 2));
      const cleanedCount = cleanupResult.data?.cleaned_count || 0;
      const cleanupMsg = cleanupResult.msg || '';
      console.log('cleanedCount:', cleanedCount, 'msg:', cleanupMsg);
      if (cleanedCount > 0) {
        message.success(cleanupMsg);
      }
      await loadSubtasks(selectedSubtaskPhase as TaskPhase);
    } catch (error: any) {
      console.error('cleanupStaleSubtasks error:', error);
      const msg = error.response?.data?.msg || '刷新失败';
      message.error(msg);
    } finally {
      setSubtaskLoading(false);
    }
  };

  const handleCopyPrompt = async (record: any) => {
    try {
      const key = `${record.phase}-${record.subtask_index}`;
      // 优先使用用户编辑过的自定义提示词，否则使用子任务的原始提示词
      const promptText = customPrompts[key]?.trim() || record.original_prompt || '';
      if (!promptText) {
        message.warning('当前子任务没有可复制的提示词');
        return;
      }
      await navigator.clipboard.writeText(promptText);
      message.success('提示词已复制到剪贴板');
    } catch (error) {
      console.error('Copy prompt error:', error);
      message.error('复制提示词失败');
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

  // R2 公开 URL
  const r2PublicUrl = import.meta.env.VITE_R2_PUBLIC_URL || 'https://aivideobucket.ldragon.xyz';

  // 获取分镜的首帧和尾帧 URL
  const getFrameUrls = (subtaskIndex: number): { firstFrameUrl: string; lastFrameUrl: string } => {
    const firstFrameUrl = `${r2PublicUrl}/${id}/ai_shot_frames/shot_${subtaskIndex}_first.jpg`;
    const lastFrameUrl = `${r2PublicUrl}/${id}/ai_shot_frames/shot_${subtaskIndex}_last.jpg`;
    return { firstFrameUrl, lastFrameUrl };
  };

  // 复制帧地址
  const handleCopyFrameUrls = async (subtaskIndex: number) => {
    const { firstFrameUrl, lastFrameUrl } = getFrameUrls(subtaskIndex);
    const text = `${firstFrameUrl}\n${lastFrameUrl}`;
    await navigator.clipboard.writeText(text);
    message.success('帧地址已复制到剪贴板');
  };

  // 下载首尾帧（通过后端代理，避免 R2 公开域名 CORS 跨域问题）
  const handleDownloadFrames = async (subtaskIndex: number) => {
    const prefix = `${id}/ai_shot_frames/`;
    const firstName = `shot_${subtaskIndex}_first.jpg`;
    const lastName = `shot_${subtaskIndex}_last.jpg`;

    const triggerDownload = (blob: Blob, filename: string) => {
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    };

    try {
      const firstBlob = await fileApi.downloadAsBlob(firstName, prefix);
      triggerDownload(firstBlob, firstName);
    } catch (error: any) {
      console.error('Download first frame error:', error);
      message.error(`首帧下载失败: ${error.response?.data?.msg || error.message || '未知错误'}`);
      return;
    }

    try {
      const lastBlob = await fileApi.downloadAsBlob(lastName, prefix);
      triggerDownload(lastBlob, lastName);
    } catch (error: any) {
      console.error('Download last frame error:', error);
      message.error(`尾帧下载失败: ${error.response?.data?.msg || error.message || '未知错误'}`);
      return;
    }

    message.success('首尾帧下载完成');
  };

  // 触发上传帧
  const handleUploadFramesClick = (phase: string, index: number) => {
    currentUploadSubtaskRef.current = { phase, index };
    if (uploadFrameInputRef.current) {
      uploadFrameInputRef.current.click();
    }
  };

  // 处理上传帧文件选择（仅允许选2个图片：首帧+尾帧，按顺序）
  const handleUploadFramesChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0 || !currentUploadSubtaskRef.current) return;

    // 必须选2个图片：第一个为首帧，第二个为尾帧
    if (files.length !== 2) {
      message.warning('请选择2个图片：第一个为首帧，第二个为尾帧');
      event.target.value = '';
      currentUploadSubtaskRef.current = null;
      return;
    }

    const { index } = currentUploadSubtaskRef.current;
    const prefix = `${id}/ai_shot_frames/`;

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // 根据文件顺序确定是首帧还是尾帧（第一个文件为首帧，第二个为尾帧）
        const suffix = i === 0 ? 'first' : 'last';
        const ext = file.name.split('.').pop() || 'jpg';
        const filename = `shot_${index}_${suffix}.${ext}`;

        // 创建带新文件名的 File 对象
        const renamedFile = new File([file], filename, { type: file.type });

        await fileApi.upload(renamedFile, prefix);
      }
      message.success(`已上传首尾帧到 ${prefix}`);
      loadSubtasks(selectedSubtaskPhase as TaskPhase);
    } catch (error: any) {
      console.error('Upload frames error:', error);
      message.error('上传帧失败');
    }

    // 清理
    event.target.value = '';
    currentUploadSubtaskRef.current = null;
  };

  // 触发上传视频
  const handleUploadVideoClick = (phase: string, index: number) => {
    currentUploadSubtaskRef.current = { phase, index };
    if (uploadVideoInputRef.current) {
      uploadVideoInputRef.current.click();
    }
  };

  // 处理上传视频文件选择（仅允许选1个视频）
  const handleUploadVideoChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0 || !currentUploadSubtaskRef.current) return;

    const { index } = currentUploadSubtaskRef.current;
    const prefix = `${id}/generated_shots/`;
    const file = files[0];
    const ext = file.name.split('.').pop() || 'mp4';
    const filename = `shot_${index}.${ext}`;
    const renamedFile = new File([file], filename, { type: file.type });

    try {
      await fileApi.upload(renamedFile, prefix);
      message.success(`已上传视频 ${filename} 到 ${prefix}`);
      loadSubtasks(selectedSubtaskPhase as TaskPhase);
    } catch (error: any) {
      console.error('Upload video error:', error);
      message.error('上传视频失败');
    }

    // 清理
    event.target.value = '';
    currentUploadSubtaskRef.current = null;
  };

  const handleSubtaskSelect = (keys: React.Key[]) => {
    setSelectedSubtaskKeys(keys);
  };

  const handleBatchRunSubtasks = async () => {
    if (selectedSubtaskKeys.length === 0) {
      message.warning('请先选择要执行的子任务');
      return;
    }

    setBatchRunning(true);
    try {
      const subtaskIds = selectedSubtaskKeys.map((key) => {
        const [phase, index] = String(key).split('-');
        return { phase, subtask_index: parseInt(index) };
      });

      const customPromptsData: Record<string, string> = {};
      for (const [key, value] of Object.entries(customPrompts)) {
        if (value?.trim()) {
          customPromptsData[key] = value.trim();
        }
      }

      await taskApi.batchRunSubtasks(id!, subtaskIds, customPromptsData);
      message.success(`已启动 ${subtaskIds.length} 个子任务的批量执行`);
      setSelectedSubtaskKeys([]);
      loadSubtasks(selectedSubtaskPhase as TaskPhase);
    } catch (error: any) {
      const msg = error.response?.data?.msg || '批量执行失败';
      message.error(msg);
    } finally {
      setBatchRunning(false);
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

  const getDerivedStatus = (task: any): string => {
    const terminalStatuses = ['COMPLETED', 'FAILED', 'CANCELLED', 'PENDING'];
    if (terminalStatuses.includes(task?.status)) {
      return task.status;
    }
    const phaseStatusMap: Record<string, string> = {
      DETECT: 'DETECTING',
      ANALYZE: 'ANALYZING',
      CROP_SHOTS: 'CROPPING_SHOTS',
      CONVERT_FRAMES: 'CONVERTING_FRAMES',
      GENERATE_SHOTS: 'GENERATING_SHOTS',
      COMPOSE: 'COMPOSING',
    };
    return phaseStatusMap[task?.current_phase] || task?.status || 'PENDING';
  };

  const getStatusTag = (status: string) => {
    const config = statusConfig[status] || { color: 'default', text: status };
    return <Tag color={config.color}>{config.text}</Tag>;
  };

  const getPhaseStatusColor = (phase: TaskPhase) => {
    const derivedStatus = getDerivedStatus(task);
    const currentPhase = task?.current_phase || '';
    
    if (derivedStatus === 'COMPLETED') return 'success';
    if (derivedStatus === 'FAILED') return 'error';
    
    const runningStatus = `${phase}ING`;
    const doneStatus = `${phase}ED`;
    
    if (derivedStatus === runningStatus) return 'processing';
    if (derivedStatus === doneStatus) return 'success';
    
    const phaseOrder: TaskPhase[] = ['DETECT', 'ANALYZE', 'CROP_SHOTS', 'CONVERT_FRAMES', 'GENERATE_SHOTS', 'COMPOSE'];
    const currentIdx = phaseOrder.indexOf(currentPhase as TaskPhase);
    const phaseIdx = phaseOrder.indexOf(phase);
    
    if (currentIdx > phaseIdx) return 'success';
    if (currentIdx === phaseIdx) return 'processing';
    
    return 'default';
  };

  const isPhaseRunning = () => {
    const runningStatuses = ['DETECTING', 'ANALYZING', 'CROPPING_SHOTS', 'CONVERTING_FRAMES', 'GENERATING_SHOTS', 'COMPOSING'];
    return runningStatuses.includes(getDerivedStatus(task));
  };

  if (!task) {
    return <Card loading />;
  }

  return (
    <div ref={containerRef}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 24 }}>
        <h2>任务详情</h2>
        <div>
          {task.status === 'PENDING' && (
            <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleStart}>
              启动任务
            </Button>
          )}
          {getDerivedStatus(task) !== 'COMPLETED' && getDerivedStatus(task) !== 'CANCELLED' && (
            <Button icon={<StopOutlined />} onClick={handleCancel} style={{ marginLeft: 8 }}>
              取消任务
            </Button>
          )}
          {getDerivedStatus(task) === 'FAILED' && (
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
            type={getDerivedStatus(task) === 'FAILED' ? 'error' : 'info'}
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}
        {task.progress > 0 && getDerivedStatus(task) !== 'COMPLETED' && getDerivedStatus(task) !== 'FAILED' && (
          <Progress percent={task.progress} status="active" style={{ marginBottom: 16 }} />
        )}
        <Descriptions bordered column={2}>
          <Descriptions.Item label="任务ID">{task.id}</Descriptions.Item>
          <Descriptions.Item label="标题">{task.title}</Descriptions.Item>
          <Descriptions.Item label="状态">{getStatusTag(getDerivedStatus(task))}</Descriptions.Item>
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
          <Descriptions.Item label="创建时间">{dayjsUtc(task.created_at).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item>
          <Descriptions.Item label="更新时间">{dayjsUtc(task.updated_at).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item>
          <Descriptions.Item label="开始时间">{task.started_at ? dayjsUtc(task.started_at).format('YYYY-MM-DD HH:mm:ss') : '-'}</Descriptions.Item>
          <Descriptions.Item label="完成时间">{task.completed_at ? dayjsUtc(task.completed_at).format('YYYY-MM-DD HH:mm:ss') : '-'}</Descriptions.Item>
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
          {(['DETECT', 'ANALYZE', 'CROP_SHOTS', 'CONVERT_FRAMES', 'GENERATE_SHOTS', 'COMPOSE'] as TaskPhase[]).map((phase) => {
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
          {(['DETECT', 'ANALYZE', 'CROP_SHOTS', 'CONVERT_FRAMES', 'GENERATE_SHOTS', 'COMPOSE'] as TaskPhase[]).map((phase) => {
            const config = phaseConfig[phase];
            const derivedStatus = getDerivedStatus(task);
            const currentPhase = task?.current_phase || '';
            
            const phaseOrder: TaskPhase[] = ['DETECT', 'ANALYZE', 'CROP_SHOTS', 'CONVERT_FRAMES', 'GENERATE_SHOTS', 'COMPOSE'];
            const currentIdx = phaseOrder.indexOf(currentPhase as TaskPhase);
            const phaseIdx = phaseOrder.indexOf(phase);
            
            let isDone = false;
            let isRunning = false;
            
            if (derivedStatus === 'COMPLETED') {
              isDone = true;
            } else if (derivedStatus === `${phase}ED`) {
              isDone = true;
            } else if (derivedStatus === `${phase}ING`) {
              isRunning = true;
            } else if (currentIdx > phaseIdx) {
              isDone = true;
            } else if (currentIdx === phaseIdx) {
              isRunning = true;
            }
            
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
                  {dayjsUtc(log.created_at).format('YYYY-MM-DD HH:mm:ss')}
                </div>
              </Timeline.Item>
            ))}
          </Timeline>
        )}
      </Card>

      <Card title="子任务管理" style={{ marginTop: 24 }}>
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 'bold' }}>选择阶段查看子任务：</span>
          <Select
            value={selectedSubtaskPhase || undefined}
            onChange={(value) => {
              setSelectedSubtaskPhase(value as TaskPhase);
              setSelectedSubtaskKeys([]);
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
          <Button type="primary" onClick={handleRefreshSubtasks} disabled={!selectedSubtaskPhase} loading={subtaskLoading}>
            刷新
          </Button>
          <div style={{ flex: 1 }} />
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={handleBatchRunSubtasks}
            disabled={selectedSubtaskKeys.length === 0}
            loading={batchRunning}
          >
            批量执行 {selectedSubtaskKeys.length > 0 ? `(${selectedSubtaskKeys.length})` : ''}
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
            rowSelection={{
              type: 'checkbox',
              selectedRowKeys: selectedSubtaskKeys,
              onChange: handleSubtaskSelect,
              getCheckboxProps: (record) => ({
                disabled: record.status === 'PROCESSING',
              }),
            }}
          >
            <Table.Column
              title="名称"
              key="name"
              width={140}
              render={(_, record) => {
                const label = phaseConfig[record.phase as TaskPhase]?.label || record.phase;
                let displayIndex = record.subtask_index;
                const duration = record.duration || 0;
                const frames = record.frames || 0;
                const durationStr = duration.toFixed(3) + '秒';
                const framesStr = frames + '帧';
                if (record.phase === 'CONVERT_FRAMES') {
                  displayIndex = Math.floor(record.subtask_index / 2);
                  const frameType = record.subtask_index % 2 === 0 ? '首帧' : '尾帧';
                  return (
                    <div>
                      <Tag color="blue">{label}-{displayIndex}({frameType})</Tag>
                      <div style={{ fontSize: '12px', color: '#999', marginTop: 4 }}>{durationStr}</div>
                      <div style={{ fontSize: '12px', color: '#999' }}>{framesStr}</div>
                    </div>
                  );
                }
                return (
                  <div>
                    <Tag color="blue">{label}-{displayIndex}</Tag>
                    <div style={{ fontSize: '12px', color: '#999', marginTop: 4 }}>{durationStr}</div>
                    <div style={{ fontSize: '12px', color: '#999' }}>{framesStr}</div>
                  </div>
                );
              }}
            />
            <Table.Column
              title="状态"
              dataIndex="status"
              key="status"
              sorter={(a, b) => {
                const order = ['PROCESSING', 'PENDING', 'FAILED', 'COMPLETED'];
                const idxA = order.indexOf(a.status);
                const idxB = order.indexOf(b.status);
                return idxA - idxB;
              }}
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
              title="重试次数"
              dataIndex="retry_count"
              key="retry_count"
              render={(retry, record) => `${retry}/${record.max_retries || 3}`}
            />
            <Table.Column
              title="错误信息"
              dataIndex="error_msg"
              key="error_msg"
              width={200}
              render={(text) => (
                <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {text || '-'}
                </span>
              )}
            />
            <Table.Column
              title="自定义提示词"
              dataIndex="custom_prompt"
              key="custom_prompt"
              width={650}
              render={(_, record) => {
                const key = `${record.phase}-${record.subtask_index}`;
                return (
                  <Input.TextArea
                    placeholder="输入自定义提示词，留空使用默认"
                    value={customPrompts[key] || ''}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                      userEditedPromptKeys.current.add(key);
                      setCustomPrompts(prev => ({ ...prev, [key]: e.target.value }));
                    }}
                    autoSize={{ minRows: 6, maxRows: 12 }}
                  />
                );
              }}
            />
            <Table.Column
              title="操作"
              key="actions"
              width={120}
              render={(_, record) => {
                const isGenerateShots = record.phase === 'GENERATE_SHOTS';
                return (
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      onClick={() => handleCopyPrompt(record)}
                      block
                    >
                      复制提示词
                    </Button>
                    <Button
                      type="primary"
                      size="small"
                      icon={<ReloadOutlined />}
                      onClick={() => handleRunSubtask(record.phase, record.subtask_index)}
                      disabled={record.status === 'PROCESSING'}
                      block
                    >
                      {record.status === 'PROCESSING' ? '处理中' : '运行'}
                    </Button>
                    {isGenerateShots && (
                      <>
                        <Button
                          size="small"
                          icon={<CopyOutlined />}
                          onClick={() => handleCopyFrameUrls(record.subtask_index)}
                          block
                        >
                          复制帧地址
                        </Button>
                        <Button
                          size="small"
                          icon={<DownloadOutlined />}
                          onClick={() => handleDownloadFrames(record.subtask_index)}
                          block
                        >
                          下载首尾帧
                        </Button>
                        <Button
                          size="small"
                          icon={<UploadOutlined />}
                          onClick={() => handleUploadFramesClick(record.phase, record.subtask_index)}
                          block
                        >
                          上传帧
                        </Button>
                        <Button
                          size="small"
                          icon={<VideoCameraOutlined />}
                          onClick={() => handleUploadVideoClick(record.phase, record.subtask_index)}
                          block
                        >
                          上传视频
                        </Button>
                      </>
                    )}
                  </Space>
                );
              }}
            />
          </Table>
        )}
      </Card>

      <Card title="文件管理" style={{ marginTop: 24 }}>
        <FileBrowser
          initialPrefix={`${task.id}/`}
          rootPrefix={`${task.id}/`}
          embedded={true}
        />
      </Card>

      {/* 隐藏的 file input，用于上传帧和视频 */}
      <input
        type="file"
        ref={uploadFrameInputRef}
        style={{ display: 'none' }}
        accept="image/*"
        onChange={handleUploadFramesChange}
      />
      <input
        type="file"
        ref={uploadVideoInputRef}
        style={{ display: 'none' }}
        accept="video/*"
        onChange={handleUploadVideoChange}
      />
    </div>
  );
}