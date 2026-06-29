# AI Video Processing System

基于Cloudflare Workers和GitHub Actions的分布式AI视频处理系统。

## 功能特性

- 🎬 **视频抽帧**: 将视频分解为高质量帧图像
- 🖼️ **AI图生图**: 使用AI模型处理每一帧
- 🎞️ **视频合成**: 将处理后的帧合成为最终视频
- 🔄 **并发控制**: GitHub账户池 + AI账户池智能调度
- 🔒 **安全认证**: JWT + RBAC权限控制
- 📊 **实时监控**: 任务进度、账户状态、系统指标

## 系统架构

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────┐
│   前端      │────▶│  Cloudflare     │────▶│  GitHub       │
│  (React)   │◀────│  Workers        │◀────│  Actions      │
└─────────────┘     └─────────────────┘     └──────────────┘
                            │                        │
                            ▼                        ▼
                    ┌───────────────┐         ┌─────────────┐
                    │  D1数据库     │         │   Docker    │
                    │  R2存储       │         │  处理环境   │
                    │  KV缓存       │         └─────────────┘
                    └───────────────┘
```

## 快速开始

### 1. 部署后端服务

```bash
cd backend
npm install
npm run deploy
```

### 2. 配置GitHub Secrets

在GitHub仓库 Settings → Secrets and variables → Actions 中添加以下Secrets:

| Secret Name | Description |
|-------------|-------------|
| `R2_ACCESS_KEY_ID` | Cloudflare R2访问密钥ID |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2访问密钥 |
| `R2_ENDPOINT_URL` | R2端点URL |
| `R2_BUCKET_NAME` | R2存储桶名称 |
| `AI_API_KEY` | AI模型API密钥 |
| `AI_BASE_URL` | AI API端点URL |
| `CALLBACK_URL` | Workers回调URL |
| `CALLBACK_SECRET` | 回调签名密钥 |
| `BACKEND_API_KEY` | 后端API密钥 |

### 3. 启用GitHub Actions

在GitHub仓库 Actions 页面启用工作流。

## 默认账户

- **用户名**: `admin`
- **密码**: `admin123`

## API端点

### 后端地址
`https://ai-video-worker.tangsong-001.workers.dev`

### 前端地址
`https://b4272ef7.ai-video-frontend-c9p.pages.dev`

### 主要API

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/v1/auth/login` | 用户登录 |
| GET | `/api/v1/tasks` | 获取任务列表 |
| POST | `/api/v1/tasks` | 创建新任务 |
| POST | `/api/v1/tasks/:id/start` | 启动任务 |
| GET | `/api/admin/accounts/github` | 获取GitHub账户列表 |
| POST | `/api/admin/accounts/github` | 添加GitHub账户 |
| GET | `/api/admin/accounts/ai` | 获取AI账户列表 |
| POST | `/api/admin/accounts/ai` | 添加AI账户 |

## 项目结构

```
├── backend/                 # Cloudflare Workers后端
│   ├── src/
│   │   ├── routes/        # API路由
│   │   ├── services/     # 业务服务
│   │   ├── middleware/   # 中间件
│   │   └── types/        # 类型定义
│   └── wrangler.toml    # Workers配置
│
├── frontend/               # React前端
│   ├── src/
│   │   ├── pages/        # 页面组件
│   │   ├── components/   # 公共组件
│   │   └── api/         # API调用
│   └── vite.config.ts   # Vite配置
│
├── docker/                 # Docker处理环境
│   └── scripts/          # 处理脚本
│
└── .github/workflows/     # GitHub Actions
```

## 技术栈

- **后端**: Cloudflare Workers, Hono, D1, R2, KV
- **前端**: React, Ant Design, Vite, TypeScript
- **CI/CD**: GitHub Actions, Docker
- **AI**: Stability AI / OpenAI / 其他兼容API

## License

MIT