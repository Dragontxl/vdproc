# 视频处理环节"重试直到全部完成"机制

## Context

当前视频处理流水线的 8 个环节中，处理多项任务的脚本（分镜生成、角色生成、帧转换、图生图）存在关键缺陷：
1. **无整体重试循环**：单项失败后只警告不重试，部分项缺失就推进到下一环节
2. **无产物校验**：脚本完成后不检查所有预期产物是否都存在
3. **进度不可见**：generate-shots.sh、generate-characters.sh、convert-frames.sh 未上报进度到后端，用户在管理平台看不到详细进度

用户要求：每个环节处理完所有序号后，整体检查是否全部完成，未完成的重试，直到全部完成才推进下一环节。同时在管理平台显示详细进度日志。

## 实现方案

### 1. 可复用的重试循环模式

在 4 个脚本的主体处理逻辑外层包一个 `MAX_ROUNDS=3` 循环：

```
首轮：处理全部项目
后续轮：只处理缺失项目（通过检查输出文件确定）
每轮结束后：上传产物到 R2 + 上报进度到后端
3轮后仍有缺失：exit 1（环节失败，停止任务）
```

**校验依据**：检查本地输出文件存在且 `size > 0`（`[ -s file ]`）。

**与现有 per-item 重试的关系**：per-item 重试（3次）处理瞬时网络错误，保留不变；外层 MAX_ROUNDS 处理"某项整体失败"（如账号 401、轮询超时）。两者正交。

### 2. 各脚本具体改造

#### generate-shots.sh（主要改造）
- **当前问题**：Python heredoc 内的 for 循环处理所有 shot，失败只警告不退出（第 279 行）
- **改造方式**：
  - 将 Python 脚本改为接收 `PENDING_INDICES` 环境变量，只处理指定的 shot 序号
  - 外层 bash 增加 `for round in $(seq 1 3)` 循环
  - 每轮结束后：Python 脚本扫描 `./generated_shots/` 目录，输出缺失的 shot 序号列表
  - 通过环境变量 `PENDING_INDICES` 传递给下一轮
  - 每轮上报进度：`curl POST $CALLBACK_URL/progress`，包含 `processed_count`、`total_count`、`failed_count`、`message`
  - 3 轮后仍有缺失：`exit 1`
- **预期产物**：`./generated_shots/shot_{i}.mp4`，i 从 0 到 SHOT_COUNT-1

#### generate-characters.sh
- **当前问题**：xargs 并行处理所有角色，仅全失败才退出（第 185 行）
- **改造方式**：
  - 每轮后读取 `character_results.txt`，过滤出 FAILED 的 ROLE_ID 作为下一轮输入
  - 校验 `./characters/${ROLE_ID}.png` 文件存在且非空
  - 3 轮后仍有失败：`exit 1`
  - 每轮上报进度到后端
- **预期产物**：`./characters/{ROLE_ID}.png`

#### convert-frames.sh
- **当前问题**：xargs 并行处理所有帧，成功数为 0 才退出（第 195 行）
- **改造方式**：
  - 每轮后读取 `frame_results.txt`，过滤出 FAILED 的帧作为下一轮输入
  - 校验 `shot_{i}_first.jpg` 和 `shot_{i}_last.jpg` 文件存在且非空
  - 3 轮后仍有失败：`exit 1`
  - 每轮上报进度到后端
- **预期产物**：`./shot_frames/shot_{i}_first.jpg`、`shot_{i}_last.jpg`

#### img2img.sh
- **当前问题**：已有 R2 断点续传逻辑（第 37-54 行 `comm -23` 求差集），但无外层重试循环
- **改造方式**：
  - 在现有 `while` 循环外再包一层 `MAX_ROUNDS` 循环
  - 每轮结束后重新 `aws s3 ls` 刷新 `/tmp/ai_frames_list.txt`，重新 `comm -23` 求 remaining
  - 为空则 break，否则继续下一轮
  - 最终校验：REMAINING_COUNT > 0 则 `exit 1`
  - 已有进度上报，只需在每轮结束时增加轮次信息

### 3. 进度上报与前端显示

#### 后端改造
- **数据库**：tasks 表增加 `status_message TEXT` 字段（ALTER TABLE）
- **TaskService.ts `updateTaskProgress`**（第 460 行）：从 body 中提取 `message` 字段，写入 `status_message` 列
- **回调接口**：`/callback/progress` 已支持任意 body，只需脚本端在 payload 中增加 `message` 字段

#### 脚本进度上报格式
```json
{
  "task_id": "xxx",
  "phase": "GENERATE_SHOTS",
  "processed_count": 3,
  "total_count": 5,
  "failed_count": 0,
  "message": "第1轮: 已完成 3/5 个分镜"
}
```

#### 前端改造
- 在任务详情/Dashboard 组件中显示 `status_message` 字段
- 显示格式：进度百分比 + 状态消息文本

### 4. 失败处理

脚本 `exit 1` → GitHub Actions 步骤失败 → `handleGitHubCallback`（TaskService.ts 第 547-554 行）收到 `status !== 'success'` → 标记任务 FAILED → 不推进下一环节。

后端已有此逻辑，无需额外修改。`error_msg` 字段可记录失败原因。

## 关键文件

- `docker/scripts/generate-shots.sh` — 主要改造，Python heredoc 重构 + 外层重试循环
- `docker/scripts/generate-characters.sh` — xargs 输入过滤 + 外层重试循环
- `docker/scripts/convert-frames.sh` — xargs 输入过滤 + 外层重试循环
- `docker/scripts/img2img.sh` — 外层重试循环包裹现有逻辑
- `backend/src/services/TaskService.ts` — `updateTaskProgress` 增加 message 字段写入
- `backend/src/database/schema.sql` — tasks 表增加 status_message 字段
- `backend/migrations/` — 新增 ALTER TABLE 迁移
- 前端 Dashboard/任务详情组件 — 显示 status_message

## 验证方式

1. **generate-shots.sh**：故意将一个账号 API key 设为无效，验证 shot 0 在 401 后自动切换账号并在重试轮次中完成
2. **进度上报**：在管理平台观察任务详情，确认能看到"第X轮: 已完成 N/M 个分镜"等消息
3. **失败场景**：将所有视频账号设为无效，验证 3 轮后任务标记为 FAILED 而非推进到 COMPOSE 阶段
4. **成功场景**：正常运行，验证所有 shot 完成后才进入 COMPOSE 阶段
