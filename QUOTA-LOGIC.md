# 额度判断逻辑说明

## 核心原则

- **零网络请求**：不调用任何 OpenAI API，不访问 chatgpt.com，不触发风控
- **纯本地文件读取**：所有数据来源于 Codex App 写入的本地文件
- **只读不写**：不修改 Codex 的任何日志/数据库文件

---

## 数据来源

### 1. SQLite 日志（`~/.codex/logs_2.sqlite`）

Codex App 将 WebSocket 通信日志写入此数据库。其中包含 `codex.rate_limits` 类型的消息，格式：

```json
{
  "type": "codex.rate_limits",
  "rate_limits": {
    "primary": { "used_percent": 5, "window_minutes": 300, "resets_at": 1778671760 },
    "secondary": { "used_percent": 54, "window_minutes": 10080, "resets_at": 1778925885 },
    "plan_type": "plus"
  }
}
```

**写入时机**：仅在新对话/新 turn 开始时，服务器返回最新的 rate_limits。

### 2. Session 文件（`~/.codex/sessions/**/rollout-*.jsonl`）

每个对话会话对应一个 JSONL 文件，包含多种事件类型：

- `session_meta`：会话元数据
- `turn_context`：当前使用的模型和 reasoning effort（智能/思考程度）
- `event_msg` (type=token_count)：token 消耗快照 + rate_limits

**关键行为**：
- 对话进行中，Codex 每隔 10-15 秒写入一个 `token_count` 事件
- 每个事件都附带 `rate_limits`，但**值只在新 turn 开始时从服务器更新**
- 同一个 turn 内，`rate_limits` 保持不变，`total_token_usage` 持续累加

### 3. 本地 token ledger（`%APPDATA%/codex-auth-switcher/local-token-ledger.json`）

应用会把 session 文件里的 `token_count` 事件整理成本地索引。这个文件只保存：

- session 文件路径、大小、修改时间
- token 计数、模型、service tier、事件时间
- rate-limit 快照

它不保存 prompt、回答内容、工具输出、access token 或 refresh token。索引用来跳过未变化的 session 文件，减少重复扫描，并让进行中对话的本地额度预估更稳定。

---

## 额度计算流程

### 第一层：直接读取（base quota）

```
readLatestLocalQuota()     → 从 session 文件尾部读取最新的 rate_limits
readLatestSqliteRateLimitQuota() → 从 sqlite 读取最新的 codex.rate_limits 记录
readLatestUsageLimitQuota()      → 从 sqlite 读取 usage_limit_reached 错误记录
```

三者取时间最新的作为 base quota。

**关键改进**：`parseLatestRateLimitFile` 返回的 `checkedAt` 是 rate_limits 值**最后一次发生变化**的时间戳，而不是最后一个事件的时间戳。这样预估逻辑才能正确计算变化后的 token 增量。

### 第二层：预估（estimate）

由于 Codex 在同一 turn 内不更新 rate_limits，实际消耗的 token 不会立即反映在 used_percent 中。预估逻辑弥补这个差距：

#### 步骤 1：计算 token 增量

`tokenDeltaSinceBase(events, baseMs)`:
- 找到 base 时间点之后的所有 token_count 事件
- 计算从 base 到最新事件的 token 消耗增量
- **特殊处理**：当同一会话内所有事件的 rate_limits 值相同时（单 turn 场景），如果 quota 快照早于本会话，则用第一个事件作为基准；如果 quota 快照发生在会话中途，则不能把基准时间倒退到会话开头，否则会把快照前的 token 重复计入 delta。
- 加权 token 会考虑模型、reasoning effort 和显式 `reasoning_output_tokens`。当前本地日志能稳定提供 `effort`，但速度模式（标准/快速）未稳定出现在 `turn_context` 中；如果模型名里带 fast/high-speed，会按高速权重处理。

#### 步骤 2：校准系数

`collectQuotaCalibration(events, planType)`:
- 遍历历史会话中 rate_limits 发生变化的点
- 计算"两次变化之间的 token 消耗量"与"used_percent 变化量"的比值
- 取中位数作为校准系数

**校准原理**：
```
事件序列：
  [tokens=0, primary=38%]
  [tokens=500K, primary=38%]    ← token 在累加，rate_limits 不变
  [tokens=1.5M, primary=38%]
  [tokens=1.5M, primary=45%]   ← 新 turn 开始，rate_limits 更新
  
校准样本：1,500,000 tokens → 7% 变化 → 系数 = 7/1500000 ≈ 4.67e-6
```

从历史数据中提取数百个这样的样本，取中位数得到稳定的系数。

#### 步骤 3：预估计算

```
estimatedUsedPercent = baseUsedPercent + coefficient × weightedTokenDelta
estimatedRemainingPercent = 100 - estimatedUsedPercent
```

#### Fallback 系数

当历史校准样本不足时，使用保守的 fallback：
- Session（5小时）：`1/250000`（约 250K tokens = 1%）
- Weekly（周）：`1/500000`（约 500K tokens = 1%）

---

## 实时更新机制

### 触发方式

| 触发源 | 机制 | 延迟 |
|--------|------|------|
| Session 文件变化 | `fs.watch` 递归监听 sessions 目录 | ~2.5s（去抖） |
| SQLite 文件变化 | `fs.watch` 监听 .codex 目录 | ~2.5s（去抖） |
| SQLite mtime 轮询 | 每 15 秒检查文件修改时间 | ≤15s |
| Widget 定时刷新 | 每 5 秒调用 getQuota() | 5s |
| 主窗口用量页 | 每 8 秒调用 getDashboard() | 8s |
| state:changed 事件 | 后台检测到数据变化时广播 | 即时 |

### 对话进行中的更新流程

```
Codex 写入 token_count 事件到 session 文件
  → sessionsWatcher 检测到文件变化
  → scheduleLocalLogRefresh()（2.5s 去抖）
  → refreshQuotaSnapshotFromLocalLog()
    → readLatestLocalQuota() 读取最新 rate_limits
    → saveAccountQuotaSnapshot() 保存到账号数据
    → broadcastStateChanged() 通知 UI
  → Widget 收到通知或 5s 定时触发
  → getQuota() 重新计算
    → base quota = 最新 rate_limits（如 used 5%）
    → token delta = base 之后的 token 消耗
    → estimate = base + coefficient × delta
  → UI 显示预估值
```

---

## 精度与限制

### 精度

- 对话进行中：预估误差通常 < 1%（基于 585 个历史校准样本）
- 对话结束后：显示"最后已知 rate_limits + 预估增量"，误差 < 2%
- 新对话开始时：立即获取服务器返回的精确值，误差 = 0

### 限制

1. **对话结束后到下一次对话前**：额度不会再变化（没有新数据写入）
2. **额度重置**：5 小时窗口到期后，只有下一次对话才能感知到重置
3. **不同模型权重**：高速模式可能有不同的 token 消耗倍率，校准系数是中位数近似
4. **首次使用**：没有历史数据时使用 fallback 系数，精度较低

### 安全保证

- `installNetworkGuards()` 硬拦截所有出站网络请求
- CSP `connect-src 'none'` 双重保障
- SQLite 以 `readOnly: true` 打开
- 不修改 Codex 的任何文件
- 不注入/hook Codex 进程
- 对 OpenAI 服务器完全透明（零流量）
