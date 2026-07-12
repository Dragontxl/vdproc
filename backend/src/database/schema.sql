CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    video_path TEXT NOT NULL,
    fps INTEGER DEFAULT 30,
    prompt TEXT,
    output_fps INTEGER DEFAULT 30,
    github_account_id INTEGER,
    ai_account_id INTEGER,
    current_run_id TEXT,
    current_phase TEXT,
    origin_frames_path TEXT,
    ai_frames_path TEXT,
    final_video_path TEXT,
    final_video_url TEXT,
    total_frames INTEGER DEFAULT 0,
    processed_frames INTEGER DEFAULT 0,
    failed_frames INTEGER DEFAULT 0,
    progress INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    expires_at TIMESTAMP,
    error_msg TEXT,
    error_stack TEXT,
    tags TEXT,
    priority INTEGER DEFAULT 0,
    status_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);

CREATE TABLE IF NOT EXISTS github_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    username TEXT,
    token_encrypted TEXT NOT NULL,
    monthly_used_minutes INTEGER DEFAULT 0,
    total_used_minutes INTEGER DEFAULT 0,
    monthly_limit INTEGER DEFAULT 2000,
    last_reset_date DATE DEFAULT CURRENT_DATE,
    is_active BOOLEAN DEFAULT TRUE,
    is_limited BOOLEAN DEFAULT FALSE,
    limit_reason TEXT,
    success_rate DECIMAL(5,2) DEFAULT 100.00,
    avg_job_duration INTEGER,
    total_jobs INTEGER DEFAULT 0,
    failed_jobs INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_github_accounts_active ON github_accounts(is_active);
CREATE INDEX IF NOT EXISTS idx_github_accounts_monthly_used ON github_accounts(monthly_used_minutes);

CREATE TABLE IF NOT EXISTS ai_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_alias TEXT NOT NULL,
    api_type TEXT DEFAULT 'image',
    api_key_encrypted TEXT NOT NULL,
    base_url TEXT,
    model_name TEXT,
    max_concurrent INTEGER DEFAULT 1,
    priority_weight INTEGER DEFAULT 50,
    cooldown_seconds INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    cooldown_until TIMESTAMP,
    is_healthy BOOLEAN DEFAULT TRUE,
    health_check_msg TEXT,
    daily_usage INTEGER DEFAULT 0,
    total_usage INTEGER DEFAULT 0,
    daily_limit INTEGER DEFAULT 1000,
    success_rate DECIMAL(5,2) DEFAULT 100.00,
    avg_response_time INTEGER,
    total_calls INTEGER DEFAULT 0,
    failed_calls INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP,
    last_health_check TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_accounts_active ON ai_accounts(is_active);
CREATE INDEX IF NOT EXISTS idx_ai_accounts_priority ON ai_accounts(priority_weight DESC);

CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT,
    phase TEXT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_logs_task_id ON operation_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON operation_logs(created_at);

CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT
);

INSERT OR IGNORE INTO system_config (key, value, description) VALUES
    ('max_concurrent_tasks', '5', '最大并发任务数'),
    ('default_fps', '30', '默认抽帧帧率'),
    ('callback_timeout', '300', '回调超时时间（秒）'),
    ('github_api_timeout', '30', 'GitHub API超时时间（秒）'),
    ('ai_api_timeout', '120', 'AI API超时时间（秒）'),
    ('default_cooldown', '60', 'AI账户默认冷却时间（秒）'),
    ('max_retry_count', '3', '最大重试次数'),
    ('task_expire_days', '7', '任务过期天数'),
    ('max_concurrent_jobs_per_github_account', '2', '每个GitHub账户最大并发任务数'),
    ('ai_rate_limit_window', '60', 'AI账户限流窗口（秒）'),
    ('ai_rate_limit_max_requests', '100', 'AI账户限流窗口内最大请求数'),
    ('frame_batch_size', '10', '帧处理批次大小'),
    ('enable_parallel_processing', 'true', '启用帧并行处理'),
    ('max_parallel_jobs', '5', '最大并行处理任务数'),
    ('checkpoint_interval', '30', '检查点保存间隔（秒）'),
    ('alert_check_interval', '60', '告警检查间隔（秒）'),
    ('enable_cost_tracking', 'true', '启用成本跟踪'),
    ('ai_cost_per_request', '0.02', '每次AI请求预估成本（美元）'),
    ('daily_budget_limit', '100', '每日预算上限（美元）'),
    ('monthly_budget_limit', '1000', '月度预算上限（美元）');

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT,
    role TEXT DEFAULT 'USER',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP,
    api_key TEXT UNIQUE
);

INSERT OR IGNORE INTO users (username, password_hash, role) VALUES
    ('admin', '$2a$10$N9qo8uLOickgx2ZMRZoMye.IjzqAKL9xL5jvMFVdNJHvGCgTq/VEq', 'ADMIN');

CREATE TABLE IF NOT EXISTS task_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    github_account_id INTEGER NOT NULL,
    phase TEXT NOT NULL,
    priority INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PENDING',
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    scheduled_at TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    run_id TEXT,
    error_msg TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id),
    FOREIGN KEY (github_account_id) REFERENCES github_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status);
CREATE INDEX IF NOT EXISTS idx_task_queue_scheduled ON task_queue(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_task_queue_priority ON task_queue(priority DESC);

CREATE TABLE IF NOT EXISTS ai_rate_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ai_account_id INTEGER NOT NULL,
    window_start TIMESTAMP NOT NULL,
    window_end TIMESTAMP NOT NULL,
    request_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ai_account_id) REFERENCES ai_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_ai_rate_limits_account ON ai_rate_limits(ai_account_id);

CREATE TABLE IF NOT EXISTS frame_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    frame_index INTEGER NOT NULL,
    frame_path TEXT NOT NULL,
    ai_account_id INTEGER,
    status TEXT NOT NULL DEFAULT 'PENDING',
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    output_path TEXT,
    error_msg TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id),
    FOREIGN KEY (ai_account_id) REFERENCES ai_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_frame_tasks_task ON frame_tasks(task_id);
CREATE INDEX IF NOT EXISTS idx_frame_tasks_status ON frame_tasks(status);

CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    labels TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(metric_name);
CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp);

CREATE TABLE IF NOT EXISTS alert_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    metric_name TEXT NOT NULL,
    condition TEXT NOT NULL,
    severity TEXT DEFAULT 'WARNING',
    is_active BOOLEAN DEFAULT TRUE,
    cooldown_seconds INTEGER DEFAULT 3600,
    last_triggered_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS alert_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER,
    message TEXT NOT NULL,
    severity TEXT,
    labels TEXT,
    triggered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    FOREIGN KEY (rule_id) REFERENCES alert_rules(id)
);

CREATE INDEX IF NOT EXISTS idx_alert_history_triggered ON alert_history(triggered_at);

CREATE TABLE IF NOT EXISTS task_checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    checkpoint_data TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON task_checkpoints(task_id);

CREATE TABLE IF NOT EXISTS shots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    shot_index INTEGER NOT NULL,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    duration REAL NOT NULL,
    scene_type TEXT,
    confidence REAL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_shots_task ON shots(task_id);
CREATE INDEX IF NOT EXISTS idx_shots_index ON shots(shot_index);

CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    role_id TEXT UNIQUE NOT NULL,
    gender TEXT,
    build TEXT,
    height TEXT,
    permanent_features TEXT,
    tags TEXT,
    avatar_path TEXT,
    best_frame_path TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_characters_task ON characters(task_id);
CREATE INDEX IF NOT EXISTS idx_characters_role ON characters(role_id);

CREATE TABLE IF NOT EXISTS shot_details (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    shot_index INTEGER NOT NULL,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    duration REAL NOT NULL,
    characters TEXT,
    speaker TEXT,
    dialogue TEXT,
    scene_description TEXT,
    lighting TEXT,
    camera_movement TEXT,
    positive_prompt TEXT,
    negative_prompt TEXT,
    first_frame_path TEXT,
    last_frame_path TEXT,
    ai_first_frame_path TEXT,
    ai_last_frame_path TEXT,
    generated_video_path TEXT,
    status TEXT DEFAULT 'PENDING',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_shot_details_task ON shot_details(task_id);
CREATE INDEX IF NOT EXISTS idx_shot_details_index ON shot_details(shot_index);

CREATE TABLE IF NOT EXISTS character_frames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    frame_path TEXT NOT NULL,
    shot_index INTEGER NOT NULL,
    position TEXT NOT NULL,
    face_confidence REAL DEFAULT 0,
    face_angle REAL DEFAULT 0,
    blur_score REAL DEFAULT 0,
    occlusion_rate REAL DEFAULT 0,
    quality_score REAL DEFAULT 0,
    is_best BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id),
    FOREIGN KEY (role_id) REFERENCES characters(role_id)
);

CREATE INDEX IF NOT EXISTS idx_character_frames_task ON character_frames(task_id);
CREATE INDEX IF NOT EXISTS idx_character_frames_role ON character_frames(role_id);
CREATE INDEX IF NOT EXISTS idx_character_frames_best ON character_frames(is_best);