export interface Task {
  id: string;
  user_id: string;
  title: string;
  status: TaskStatus;
  video_path: string;
  fps: number;
  prompt: string;
  output_fps: number;
  github_account_id: number;
  ai_account_id: number;
  current_run_id: string;
  current_phase: string;
  origin_frames_path: string;
  ai_frames_path: string;
  final_video_path: string;
  final_video_url: string;
  total_frames: number;
  processed_frames: number;
  failed_frames: number;
  retry_count: number;
  max_retries: number;
  created_at: string;
  updated_at: string;
  started_at: string;
  completed_at: string;
  expires_at: string;
  error_msg: string;
  error_stack: string;
  tags: string;
  priority: number;
}

export type TaskStatus = 'PENDING' | 'EXTRACTING' | 'EXTRACTED' | 'IMG2IMGING' | 'IMG2IMGED' | 'COMPOSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface GitHubAccount {
  id: number;
  name: string;
  username: string;
  token_encrypted: string;
  monthly_used_minutes: number;
  total_used_minutes: number;
  monthly_limit: number;
  last_reset_date: string;
  is_active: boolean;
  is_limited: boolean;
  limit_reason: string;
  success_rate: number;
  avg_job_duration: number;
  total_jobs: number;
  failed_jobs: number;
  created_at: string;
  updated_at: string;
  last_used_at: string;
}

export interface AIAccount {
  id: number;
  account_alias: string;
  api_key_encrypted: string;
  base_url: string;
  model_name: string;
  max_concurrent: number;
  priority_weight: number;
  cooldown_seconds: number;
  is_active: boolean;
  cooldown_until: string;
  is_healthy: boolean;
  health_check_msg: string;
  daily_usage: number;
  total_usage: number;
  daily_limit: number;
  success_rate: number;
  avg_response_time: number;
  total_calls: number;
  failed_calls: number;
  created_at: string;
  updated_at: string;
  last_used_at: string;
  last_health_check: string;
}

export interface SystemConfig {
  key: string;
  value: string;
  description: string;
  updated_at: string;
  updated_by: string;
}

export interface FrameTask {
  id: number;
  task_id: string;
  frame_index: number;
  frame_path: string;
  ai_account_id: number;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  retry_count: number;
  max_retries: number;
  started_at: string;
  completed_at: string;
  output_path: string;
  error_msg: string;
  created_at: string;
}

export interface ApiResponse<T = any> {
  code: number;
  data: T;
  msg: string;
}