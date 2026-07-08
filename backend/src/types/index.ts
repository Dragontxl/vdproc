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

export type TaskPhase =
  | 'DETECT'
  | 'ANALYZE'
  | 'SELECT_FACES'
  | 'GENERATE_CHARACTERS'
  | 'CROP_SHOTS'
  | 'CONVERT_FRAMES'
  | 'GENERATE_SHOTS'
  | 'COMPOSE';

export type TaskStatus =
  | 'PENDING'
  | 'DETECTING' | 'DETECTED'
  | 'ANALYZING' | 'ANALYZED'
  | 'SELECTING_FACES' | 'FACES_SELECTED'
  | 'GENERATING_CHARACTERS' | 'CHARACTERS_GENERATED'
  | 'CROPPING_SHOTS' | 'SHOTS_CROPPED'
  | 'CONVERTING_FRAMES' | 'FRAMES_CONVERTED'
  | 'GENERATING_SHOTS' | 'SHOTS_GENERATED'
  | 'COMPOSING' | 'COMPLETED'
  | 'FAILED' | 'CANCELLED';

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

export interface Shot {
  id: number;
  task_id: string;
  shot_index: number;
  start_time: number;
  end_time: number;
  duration: number;
  scene_type: string;
  confidence: number;
  created_at: string;
}

export interface Character {
  id: number;
  task_id: string;
  role_id: string;
  gender: string;
  build: string;
  height: string;
  permanent_features: string;
  tags: string;
  avatar_path: string;
  best_frame_path: string;
  created_at: string;
  updated_at: string;
}

export interface ShotDetail {
  id: number;
  task_id: string;
  shot_index: number;
  start_time: number;
  end_time: number;
  duration: number;
  characters: string;
  speaker: string;
  dialogue: string;
  scene_description: string;
  lighting: string;
  camera_movement: string;
  positive_prompt: string;
  negative_prompt: string;
  first_frame_path: string;
  last_frame_path: string;
  ai_first_frame_path: string;
  ai_last_frame_path: string;
  generated_video_path: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CharacterFrame {
  id: number;
  task_id: string;
  role_id: string;
  frame_path: string;
  shot_index: number;
  position: string;
  face_confidence: number;
  face_angle: number;
  blur_score: number;
  occlusion_rate: number;
  quality_score: number;
  is_best: boolean;
  created_at: string;
}

export interface ApiResponse<T = any> {
  code: number;
  data: T;
  msg: string;
}