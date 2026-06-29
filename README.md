# AI Video Generator

基于Cloudflare生态和GitHub Actions构建的分布式AI视频处理系统。

## 功能特性

- 视频抽帧（支持自定义帧率）
- AI图生图（支持Stable Diffusion等模型）
- 视频合成（将处理后的帧重新合成为视频）
- 多账户负载均衡（GitHub和AI账户池）
- 任务队列管理
- 实时进度监控
- 错误重试机制
- 成本跟踪

## 技术栈

### 后端
- Cloudflare Workers
- Cloudflare D1（SQLite数据库）
- Cloudflare R2（对象存储）
- Hono（Web框架）
- TypeScript

### 前端
- React 18
- Ant Design
- React Router
- Axios

### 处理流程
- GitHub Actions（CI/CD）
- Docker（环境隔离）
- FFmpeg（视频处理）
- Stable Diffusion API（AI图像生成）

## 项目结构

```
ai-video-generator/
├── backend/                    # Cloudflare Workers后端
│   ├── src/
│   │   ├── index.ts            # 主入口
│   │   ├── routes/             # API路由
│   │   │   ├── public/         # 公开路由
│   │   │   └── admin/          # 管理路由
│   │   ├── services/           # 业务逻辑
│   │   ├── middleware/         # 中间件
│   │   ├── database/           # 数据库Schema
│   │   ├── types/              # TypeScript类型
│   │   └── scheduled.ts        # 定时任务
│   ├── wrangler.toml           # Cloudflare配置
│   └── package.json
├── frontend/                   # React前端
│   ├── src/
│   │   ├── components/         # 组件
│   │   ├── pages/              # 页面
│   │   ├── api/                # API客户端
│   │   ├── App.tsx             # 主应用
│   │   └── main.tsx            # 入口文件
│   └── package.json
├── docker/                     # Docker配置
│   ├── Dockerfile              # 处理环境镜像
│   └── scripts/                # 处理脚本
│       ├── extract-frames.sh   # 抽帧脚本
│       ├── img2img.sh          # 图生图脚本
│       └── compose-video.sh    # 合成脚本
├── .github/workflows/          # GitHub Actions工作流
├── docker-compose.yml          # Docker Compose配置
└── package.json                # 根配置
```

## 部署步骤

### 1. 初始化项目

```bash
npm install
cd backend && npm install
cd ../frontend && npm install
```

### 2. 配置Cloudflare

```bash
# 登录Cloudflare
npx wrangler login

# 创建D1数据库
npx wrangler d1 create ai-video-db

# 创建R2存储桶
npx wrangler r2 bucket create ai-video-bucket

# 创建KV命名空间
npx wrangler kv:namespace create AI_VIDEO_KV
```

### 3. 配置环境变量

复制并修改 `backend/wrangler.toml` 中的占位符：

- `ADMIN_API_KEY`: 管理员API密钥
- `CALLBACK_SECRET`: 回调签名密钥
- `ENCRYPTION_KEY`: 加密密钥（32字节）
- `JWT_SECRET`: JWT签名密钥
- `D1_DATABASE_ID`: D1数据库ID
- `KV_ID`: KV命名空间ID

### 4. 设置GitHub Actions Secrets

在GitHub仓库的Settings -> Secrets中添加：

- `AWS_ACCESS_KEY_ID`: R2访问密钥
- `AWS_SECRET_ACCESS_KEY`: R2秘密密钥
- `AWS_ENDPOINT_URL`: R2端点URL
- `AWS_BUCKET_NAME`: R2存储桶名称
- `CALLBACK_URL`: Worker回调URL
- `CALLBACK_SECRET`: 回调签名密钥
- `AI_API_KEYS`: AI账户API密钥JSON

### 5. 部署后端

```bash
cd backend
npm run deploy
```

### 6. 部署前端

```bash
cd frontend
npm run build
npx wrangler pages deploy build
```

## API接口

### 任务管理

```
GET    /api/v1/tasks          # 获取任务列表
GET    /api/v1/tasks/:id      # 获取任务详情
POST   /api/v1/tasks          # 创建任务
PUT    /api/v1/tasks/:id      # 更新任务
DELETE /api/v1/tasks/:id      # 删除任务
POST   /api/v1/tasks/:id/start    # 启动任务
POST   /api/v1/tasks/:id/cancel   # 取消任务
POST   /api/v1/tasks/:id/retry    # 重试任务
```

### 账户管理（需要认证）

```
GET    /api/admin/accounts/github    # 获取GitHub账户列表
POST   /api/admin/accounts/github    # 创建GitHub账户
PUT    /api/admin/accounts/github/:id    # 更新GitHub账户
DELETE /api/admin/accounts/github/:id    # 删除GitHub账户

GET    /api/admin/accounts/ai       # 获取AI账户列表
POST   /api/admin/accounts/ai       # 创建AI账户
PUT    /api/admin/accounts/ai/:id       # 更新AI账户
DELETE /api/admin/accounts/ai/:id       # 删除AI账户
```

### 回调接口

```
POST   /api/v1/callback/github    # GitHub Actions回调
POST   /api/v1/callback/progress  # 进度更新回调
POST   /api/v1/callback/complete  # 任务完成回调
POST   /api/v1/callback/error     # 错误回调
```

## 使用说明

1. 在前端管理界面添加GitHub和AI账户
2. 创建任务并上传视频
3. 启动任务，系统会自动调度处理
4. 查看任务进度和结果

## 许可证

MIT