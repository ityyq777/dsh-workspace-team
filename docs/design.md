# 工作区团队（Workspace Team）设计

> 状态：设计草案 v0.1。字段级规范见 [team.json 字段规范](./team-json.md)，机器可读定义见 [team.schema.json](../schema/team.schema.json)，可运行示例见 [examples/team.json](../examples/team.json)。
>
> 本文补全你草案里缺失的部分，并把你没有展开的隐含决策写清楚。文中标注“补”的段落是新增设计，标注“决策”的段落需要你确认。

## 1. 一句话

**一个工作区声明一个团队；团队用 agent 组成多个有向有环的 pipeline，channel 是带类型契约的边；工作区级团队引擎负责把节点调度到真实 agent 会话，并记录 agent ↔ session ↔ 当前 pipeline/node 的绑定。**

团队引擎本身不调用 LLM，也不替 agent 做决策。它只做五件事：

1. 读配置、校验、建图。
2. 拉起/恢复 agent 会话，写系统提示词与 roster。
3. 计算节点何时就绪，把输入交付物和任务说明投递给 agent。
4. 校验 agent 提交的交付物，按 channel 路由。
5. 记录状态、事件、绑定，驱动 UI。

## 2. 与现有“会话级 Team”的区别

DSH 已有两类相近能力，本设计不复用它们的运行时，但复用它们的实现手法。

| 维度 | `dsh-experimental-agent-team` | `dsh-agents`（squads） | 本设计 |
|---|---|---|---|
| 作用域 | 单个会话内的 Lead + teammates | 一个 squad 的一次运行 | 工作区级，配置持久化在 workspace |
| 编排 | Lead agent 自行 spawn/派活 | Lead agent 按目标组织 | 声明式 pipeline/channel，引擎确定性调度 |
| 图 | 任务板依赖 DAG | 无显式图 | 有向有环图，channel 即边 |
| 会话 | teammate 是子会话 | 每个成员一个真实会话 | 每个 agent 恰好一个真实会话，可被多个节点复用 |
| UI | 会话内 roster/任务板 | 独立面板 | 对话输入框上方的绑定悬浮条 + 团队面板 |
| 适合 | 临时协作、探索 | 一次性整队任务 | 长期存在、反复运行的工作流 |

**设计取舍**：不让一个 Lead agent 决定调度。调度必须可预测、可审计、可重放；否则有环图的终止、交付物校验、失败重试都不可控。

## 3. 核心概念与不变量

### 3.1 概念

- **Team**：工作区唯一的团队声明。
- **Agent**：一个角色 + 一个真实 DSH 会话 + 一套系统提示词/工具。
- **Pipeline**：一张有向有环图，有 entry、terminal、budget。
- **Node**：pipeline 里的一个执行位，绑定一个 agent；同一 agent 可被多个 node 引用，但串行执行。
- **Channel**：一条有向边，声明 from/to、交付物类型、验收条件、路由条件、投递策略。
- **Artifact**：一次成功提交的交付物，带内容、hash、provenance、schema 校验结果。
- **Activation**：节点的一次执行实例；消费一组输入，产生一组输出。
- **Run**：pipeline 的一次运行；包含多个 activation 和 artifact。

### 3.2 不变量

1. 一个工作区最多一个 `team.json`，路径固定。
2. channel 是图的唯一事实来源；node 的入/出通道由 channel 反向推导。
3. 一个 agent 恰好绑定一个会话（1:1）；同一时刻最多执行一个 activation，复用时按 agent FIFO 串行。
4. 一个 activation 的输入在 dispatch 时被原子消费，不会被另一个 activation 重复消费。
5. 任何环都必须有界；无界环在加载期拒绝。
6. 交付物先验收、后路由；验收失败不产生 delivery。
7. 引擎不执行交付物内容，只存储、校验、传递。
8. 所有运行状态可从 append-only 事件日志重建。

## 4. 总体架构

```text
┌────────────────────────────── workspace ──────────────────────────────┐
│  .dsh/.dsh-workspace-team/team.json                                  │
│         │                                                            │
│         ▼                                                            │
│  ┌────────────────┐   事件/状态    ┌──────────────────────────────┐  │
│  │  Team Engine   │◄──────────────►│ state/ + runs/ (event log)   │  │
│  │  (Host plugin) │                └──────────────────────────────┘  │
│  └───────┬────────┘                                                  │
│          │ session.create / prompt / steer                           │
│          ▼                                                           │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐          │
│  │ agent session  │  │ agent session  │  │ agent session  │  ...     │
│  │  (analyst)     │  │  (builder)     │  │  (reviewer)    │          │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘          │
│          │ tools             │ tools             │ tools             │
│          ▼                   ▼                   ▼                   │
│   team_submit_artifact / team_finish / team_inputs / team_status     │
│                                                                      │
│  Web UI: conversation.composer.dock  ←  GET /binding?sessionId=...   │
└──────────────────────────────────────────────────────────────────────┘
```

- **Host 插件**：配置加载、图引擎、会话管理、HTTP 路由、工具注册。
- **Client 插件**：悬浮面板、团队面板、控制按钮。
- **Agent 会话**：真实顶层会话，用户可在侧边栏看到并直接对话。
- **工具**：按 agent 会话作用域安装，只在该会话可见。

## 5. 配置目录

```text
<workspace>/.dsh/.dsh-workspace-team/
├── team.json                 # 唯一入口
├── schemas/                  # 交付物 JSON Schema
├── prompts/                  # agent / node 提示词
├── state/
│   ├── engine.json           # 引擎实例信息
│   ├── engine.lock           # 单实例锁
│   ├── bindings.json         # agent ↔ session 绑定账本
│   └── config.cache.json     # 解析/编译缓存（可选）
├── runs/
│   └── <runId>/
│       ├── run.json
│       ├── events.jsonl
│       └── artifacts/<artifactId>/{meta.json,content.json|content.txt}
└── logs/engine.log
```

- 源文件：`team.json`、`schemas/`、`prompts/`。
- 运行时：`state/`、`runs/`、`logs/`。
- 所有路径做 realpath 检查，禁止 `..`、绝对路径、反斜杠、symlink 逃逸。
- file sink 的路径相对工作区根目录，且禁止指向配置目录内部。

## 6. 图模型与执行语义

### 6.1 channel 是边

```json
{
  "id": "spec",
  "from": { "kind": "node", "pipelineId": "delivery", "nodeId": "analyst" },
  "to":   { "kind": "node", "pipelineId": "delivery", "nodeId": "builder" },
  "artifact": { "kind": "json", "schema": "schemas/spec.schema.json" }
}
```

- node 的**入通道**：所有 `to` 指向它的 channel。
- node 的**出通道**：所有 `from` 指向它的 channel。
- 不需要在 node 上再列一遍 channel，避免三处不一致。
- 外部两端：`from: external/user`（启动 brief）、`to: external/file`（落盘）。
- v1 限制：node→node 的 channel 两端必须同 pipeline；跨 pipeline 留给 v2 的 port。

### 6.2 节点何时就绪

引擎为每条 channel 维护一个 FIFO：已验收、已通过 `when`、未被消费的交付物。

对节点 N，按 `inputs.mode` 计算：

- `all`：每个 `delivery.required=true` 的入通道都至少有一个未消费交付物。可选入通道有货时一并带上。
- `any`：任一 required 入通道有未消费交付物。
- `quorum`：有未消费交付物的 required 入通道数 ≥ `quorum`。

满足后节点进入 `ready`，但**不立刻消费**。真正 dispatch 时再原子标记消费；如果派发前被取消/暂停，交付物释放回队列。

### 6.3 activation 消息（补：你草案里的第 2 点）

你草案的第 2 点当时是空的。这里补成：**调度授权（dispatch）**。

agent 初始化后处于 `standby`，它不需要轮询，也不需要申请许可。引擎在 join 满足时发送一条 `[team:activation]` 消息，这条消息就是“允许执行”。消息必须包含：

```text
[team:activation] act_01J...
team: product-delivery
pipeline: delivery (需求交付)
node: builder (实现)
agent: builder (实现者)
run: run_01J...
iteration: 2 / 4
goal: 为 CLI 增加 --json 输出

inputs:
- channel: review
  artifact: art_01J...
  from: delivery/reviewer (评审者)
  summary: 需要处理 2 个 blocker
  schema: schemas/review.schema.json
  path: .dsh/.dsh-workspace-team/runs/.../content.json
  content: { ... }            # inline 策略允许时

outputs (finish 前必须提交):
- channel: build-report
  required: true
  schema: schemas/build-report.schema.json

rules:
- 只通过 team_submit_artifact 提交交付物
- 全部必需输出被接受后调用 team_finish
- 不要修改 .dsh/.dsh-workspace-team/

instructions:
<node.instructions 渲染结果>
```

要点：

1. **输入带 provenance**：agent 明确知道哪份交付物来自哪个 pipeline/node/agent、哪个 channel、哪次 activation。这就是你草案第 3 点的落地。
2. **输出契约前置**：agent 在开始前就知道要交什么、schema 在哪、哪些是必需的。
3. **任务说明与系统提示词分离**：node instructions 只出现在 activation 里，不写进系统提示词，保证系统提示词稳定、可缓存。
4. **完成协议明确**：`team_finish` 才算完成；回合结束但没 finish 会触发提醒，再超时判失败。

投递通道：

- 如果 agent 当前 idle：`agent.send(message, "next-turn", wakeup=true)`。
- 如果 agent 正被用户对话占用：等待 idle（受 timeout 约束），再 send；或按 `humanChat=steer` 注入。
- 如果 agent 正在执行另一个 activation：per-agent FIFO 排队，等当前 activation 结束。
- `delivery.timing=immediate` 的交付物可以在 activation 运行中通过 `agent.steer` 注入，但默认 `on-activate`，避免半套输入把 agent 提前唤醒。

### 6.4 有环图必须有界

有环是需求，但必须有终止保证。加载期对每个 SCC（强连通分量）：

- 若 SCC 大小 > 1，或存在自环；
- 则要求环上至少一个节点有有限 `activation.maxActivations`，**或** pipeline 的 `budget.maxNodeRuns` / `maxWallClockMs` 有限；
- 否则拒绝加载。

运行时四层上限：

1. 节点 `maxActivations`（每次 run 计数）。
2. channel `maxDeliveries`（v1.1 候选，当前 schema 未提供；先用节点上限 + run budget 代替）。
3. pipeline `budget.maxNodeRuns` / `maxArtifacts` / `maxWallClockMs`。
4. 引擎全局并发与超时。

节点达到 `maxActivations` 后标记 `exhausted`：不再参与调度。如果此时终止条件无法满足且没有其他可运行节点，run 以 `budget_exhausted` 结束，并记录哪个节点先耗尽。

### 6.5 终止

一个 run 完成需要同时满足：

1. terminal 节点按 `completion.mode` 成功过（`all-terminal` 要求全部，`any-terminal` 要求任一）。
2. 图中没有 `ready`、`dispatching`、`running` 的节点。
3. 没有会被 `immediate` 投递触发的未处理队列。
4. 没有等待重试的 activation。

然后进入 `completing`：写 run 摘要、清理临时状态、发事件，最后 `completed`。

失败路径：

- 节点失败且 `onFailure=fail-pipeline` → run `failed`。
- 节点失败但 `continue` → 记录失败，继续调度其他分支；若 terminal 无法完成，最终 `failed`。
- `retry` → 按 `retry.maxAttempts` / `backoffMs` 重派，复用同一组输入，不重新消费。
- 墙钟/预算超限 → `budget_exhausted`。
- 用户取消 → `cancelled`；运行中的 agent turn 是否 cancel 由取消 API 参数决定。

### 6.6 暂停/恢复

- `pause`：停止新的 dispatch；running 的 activation 允许跑完；ready 队列保留；immediate 投递暂停。
- `resume`：重新计算 ready，继续 dispatch；不重置节点计数。
- 引擎重启：`resumeInterrupted=mark-failed`（默认）把中断的 activation 标失败并按 `onFailure` 处理；`redispatch` 用同一组输入重派；`never` 只记录、不自动处理。

## 7. 交付物（Artifact）

### 7.1 生命周期

```text
submit → size/type check → schema validate → acceptance predicates
      → store (canonical) → when predicates
          ├─ false → filtered（入库、记录、不投递）
          └─ true  → delivery 入队 / immediate steer / file sink
```

- **submit**：agent 调用 `team_submit_artifact`，参数三选一：`text`、`json`、`path`。`path` 指向工作区文件，引擎读取后按同一流程处理，适合大文本。
- **size/type**：不得超过 channel `maxBytes` 与 `storage.maxArtifactBytes`。
- **schema**：JSON 用 Ajv 2020-12（或 draft-07）校验；错误原样返回给 agent。
- **acceptance**：额外的 JSON Pointer 条件，用于业务验收。
- **store**：写 canonical 内容 + `meta.json`（id、sha256、producer、run、channel、schema hash、createdAt）。
- **when**：路由条件；false 只记录 filtered，不投递。
- **delivery**：按 `delivery.timing` 入队或即时投递；file sink 原子写盘。

失败语义：

- schema/acceptance 失败：工具返回错误，不入库、不投递、不算输出义务完成；agent 可在同一 activation 内修正重提。
- 重复提交同一 channel：每次都是新 artifact；默认只投递最新，旧的可被 retention 清理。需要“每次都要处理”的语义时，消费队列会保留多个。
- 输出义务：`channel.required=true` 的通道，在 `team_finish` 时必须有**本次 activation** 被接受的 artifact。

### 7.2 provenance

每个 artifact 固定带：

```json
{
  "artifactId": "art_01J...",
  "channelId": "review",
  "pipelineId": "delivery",
  "nodeId": "reviewer",
  "agentId": "reviewer",
  "runId": "run_01J...",
  "activationId": "act_01J...",
  "attempt": 1,
  "sha256": "...",
  "summary": "需要处理 2 个 blocker",
  "path": ".dsh/.dsh-workspace-team/runs/.../content.json",
  "schema": { "path": "schemas/review.schema.json", "sha256": "..." },
  "createdAt": "2026-..."
}
```

activation 消息、面板、事件日志、run 摘要都复用这个结构。agent 不需要猜“这份东西是谁给的”。

### 7.3 内联策略

- `auto`：内容 ≤ `min(channel.delivery.maxInlineBytes, storage.maxInlineBytes)` 时内联，否则只给 path + summary。
- `always`：总是内联；超过 cap 在提交时就拒绝，避免消息爆炸。
- `path`：只给 path + summary，agent 需要时自己读文件。

内联内容永远放在显式的 `content` 字段里，并与 `path` 同时出现；agent 可以只读不内联。

### 7.4 file sink

- 只支持 text（v1）；写入前做路径检查与目录创建。
- 原子写：同目录临时文件 → fsync → rename。
- `overwrite=false` 时若目标存在则拒绝，节点收到错误。
- 写失败按节点失败处理，可重试。
- 禁止写入 `.dsh/.dsh-workspace-team/`，防止团队改自己的配置/状态。

### 7.5 保留

- 按 channel `retention.keepLast` / `keepDays`，以及 run 级 `storage.retainRuns` / `retainDays`。
- GC 在 run 完成时与引擎启动时执行；先删最旧 run，再删通道内旧 artifact。
- 被引用的 artifact（未消费队列、当前 activation 输入）不删。

## 8. Agent 运行态

### 8.1 状态机

```text
unbound ──provision──► provisioning ──ready──► standby
                                                 │  ▲
                                            dispatch │  │ finish/timeout
                                                 ▼  │
                                               running
                                                 │
                                      session lost / provision fail
                                                 ▼
                                              failed
unbound / standby / failed ──release──► released
```

- `unbound`：配置存在，会话尚未创建。
- `provisioning`：创建会话、固定使用 `standard` agent preset、应用 permission preset / 模型、写系统提示词、装工具、发 bootstrap。
- `standby`：会话就绪，等待 activation；可接受用户对话。
- `running`：正在执行一个 activation。
- `failed`：provisioning 失败或会话丢失。
- `released`：显式释放/关闭会话；绑定保留为 released 记录。

**补**：你草案只写了“等待允许”。这里明确 standby 不是“agent 在循环里等”，而是“会话空闲，引擎持有调度权”。agent 不会轮询，也不会因为空闲而消耗 token。

### 8.2 拉起会话

使用 Host 的 typert gateway 创建真实会话（与 squads 相同的手法）：

```text
session.create({ workspaceId, agentPreset: "standard" }) → sessionId
session.rename(sessionId, title)
session.selectModel(sessionId, provider/model)
commands.execute(agent, "/permission " + permission)   # permission 是 preset 名称
```

**一个 agent 恰好一个会话**。不为单次 run 新建会话，也不存在 `per-run` 模式；agent 被多个 node 复用时复用同一个会话，激活按 per-agent FIFO 串行。需要运行隔离时定义独立 agent，而不是给同一 agent 开多个会话。

**agent preset 固定为 `standard`，不提供选择**。team.json 的每个 agent 必须记录 `"preset": "standard"`，schema 用 `const` 固定；引擎创建会话时始终传这个值。保留字段是为了让配置自描述、可审计、可恢复，不是让用户挑 preset。团队自己的提示词和工具是**叠加**在 `standard` 之上，不替代它。

**权限用 DSH 的 permission preset**。`agent.permission` 是 preset 名称，不是 sandbox 三值枚举；它与 `standard` agent preset 是两套独立机制：`standard` 决定“加载什么”，permission preset 决定“沙箱与审批”。引擎从 Host 的 `permissionPresets` catalog 解析；未知名称使 provision 失败（`TEAM_PERMISSION_UNKNOWN`），不静默回退。缺省不写时用部署默认 permission preset。`auto` 取决于部署是否启用 Auto 集成，`custom` 是派生状态，不可配置。

配置只在 provision 时应用；用户之后在会话里切换 permission preset 属于 DSH 正常操作。引擎记录实际 preset 并在诊断里标 `permission-drift`，不每轮强制回滚。

然后：

1. 写绑定账本（`state/bindings.json`），状态 `provisioning`。
2. 注册该会话作用域的团队工具。
3. 写系统提示词 section/context。
4. 发 bootstrap（`wake` 模式），等 READY；或 `silent` 直接转 standby。
5. 绑定状态改 `standby`。

顺序很重要：**先写绑定，再发首条 prompt**。这样 `agent/created` 事件触发时，工具安装逻辑能查到绑定；崩溃恢复也能对账。

### 8.3 系统提示词组成

每个 agent 会话固定三段：

| 段 | 注入方式 | order | 内容 |
|---|---|---|---|
| 角色 | `systemPrompt.section` | `DEPLOYMENT_PERSONA_PREFIX + 10` | `agent.systemPrompt` + `role` |
| roster | `systemPrompt.context`（required） | `TEAM_IDENTITY + 1` | 团队与全部 agent 的静态名册 |
| 协议 | `systemPrompt.context`（required） | `TEAM_IDENTITY + 2` | 只通过 channel 交接、工具用法、禁止改配置、完成协议 |

为什么 roster/协议用 `context` 而不是 `section`：

- context 是持久 user-role 快照，preset 的 `complete` section 不会把它顶掉；
- roster 是静态的，快照一次后不会每轮重复；
- 协议需要“始终在”，不依赖 preset 是否保留。

roster 只放**静态名册**，不放运行状态：

```json
{
  "team": { "id": "product-delivery", "name": "产品交付团队" },
  "self": { "agentId": "builder", "name": "实现者", "role": "按规格实现并自测" },
  "members": [
    {
      "agentId": "analyst",
      "name": "分析师",
      "role": "需求分析与规格撰写",
      "nodes": [{ "pipelineId": "delivery", "nodeId": "analyst" }],
      "channels": { "in": ["brief"], "out": ["spec"] }
    }
  ]
}
```

不把完整 `team.json` 塞进去：会泄露其他 agent 的提示词、放大 token、让缓存频繁失效。运行状态通过 `team_status` 工具按需查。

**补**：node instructions 不进系统提示词。因为同一 agent 可能被多个 node 复用，instructions 随 activation 变化；放进系统提示词会让缓存每轮失效，也会让 agent 分不清当前任务。

### 8.4 bootstrap 与 standby

`wake` 模式的 bootstrap 消息：

```text
[team:bootstrap]
你已被初始化为“产品交付团队”的 agent: builder（实现者）。
你的节点：delivery/builder。
你的入通道：spec, review；出通道：build-report。
团队名册与协作协议已在系统上下文中。

当前状态：standby。
请只回复一行：READY
不要开始任何任务；收到 [team:activation] 后再执行。
```

- `wake` 会消耗一个回合，但能验证 preset、权限、模型、工具都正常，并让会话在侧边栏有可见内容。
- 大团队/成本敏感时用 `silent`：只写系统提示词/context，不产生回合；首次 activation 时再验证。
- `eager` provisioning 会在 `team up` 时初始化全部 agent；`lazy` 在首次使用时初始化。默认 eager，符合你草案的“初始化时告知”。

### 8.5 工具

按会话作用域安装，只对绑定会话可见：

| 工具 | 作用 |
|---|---|
| `team_get_context` | 返回当前 team/agent/node/run、roster、输入要求、输出契约。 |
| `team_list_inputs` | 列出本次 activation 的输入及 provenance、消费状态。 |
| `team_submit_artifact` | 提交 text/json/path，返回 artifactId、校验错误、投递数。 |
| `team_finish` | 声明 succeeded/failed/blocked；校验必需输出；结束 activation。 |
| `team_status` | 只读查询 pipeline/run/节点状态（受限，不泄露其他 agent 的私密内容）。 |
| `team_report_blocked` | v1.1：向引擎/用户提问，节点进入 blocked。 |

控制类工具（任意工作区会话可用，需权限）：

| 工具 | 作用 |
|---|---|
| `team_status` | 团队/引擎/运行概览。 |
| `team_run_pipeline` | 启动一次 run，可带 brief。 |
| `team_pause` / `team_resume` | 暂停/恢复 run 或整个引擎。 |
| `team_stop` | 停止 run。 |
| `team_reload` | 手动重载配置。 |

命名冲突：`team_*` 可能与实验性 agent-team 的工具重名。加载时检测已注册工具，冲突则报错并提示改用 `wteam_*` 前缀；不要静默覆盖。

工具鉴权：

- handler 从会话 id 查绑定；没有绑定直接拒绝。
- 只能提交“当前节点出通道”的 channel；不能替别的 agent 提交。
- 不能指定任意 runId/activationId；这些由引擎上下文注入。

### 8.6 用户直接对话

- 默认 `humanChat=allow`：用户可以在侧边栏打开绑定会话直接聊。
- 用户消息不会自动成为交付物；agent 仍应通过 channel 交接。
- 用户消息与 activation 同时到达：per-agent FIFO；正常情况 activation 等当前回合结束。
- `deny`：输入框禁用并提示“该会话由团队引擎调度”。
- `steer`：用户消息作为 steer 注入当前 activation；适合人在环纠偏，不适合长对话。

**待确认**：用户消息是否应该暂停当前节点？我倾向于不暂停，只记录 `human.message` 事件；否则用户一句闲聊会打断流水线。

### 8.7 绑定账本

`state/bindings.json`：

```json
{
  "version": 1,
  "bindings": {
    "analyst": {
      "agentId": "analyst",
      "sessionId": "sess_...",
      "workspaceId": "ws_...",
      "state": "standby",
      "title": "产品交付团队 / 分析师",
      "createdAt": "2026-...",
      "lastSeenAt": "2026-..."
    }
  }
}
```

- key 是 agentId。一个 agent 只有一个会话，所以不存在 `agentId@runId` 形式的 per-run 绑定。
- 启动对账：会话不存在 → `session-lost`；workspace 不匹配 → 拒绝绑定；配置里 agent 已删除 → 标记 orphaned，不自动删会话。
- 面板按 `sessionId` 反查绑定，不依赖会话日志。

## 9. 团队引擎

### 9.1 生命周期

```text
stopped → starting → running ⇄ degraded → stopping → stopped
```

- **发现**：Host 启动/打开工作区时扫描 `.dsh/.dsh-workspace-team/team.json`；也可以在第一次调用团队工具/面板查询时懒加载。
- **加载**：JSON Schema → 语义校验 → 编译交付物 schema → 解析 prompts → 建图。
- **启动**：`team up` 触发；eager 时 provision 全部 agent；`start.mode=auto` 的 pipeline 自动跑一次。
- **degraded**：配置无效、锁被占用、部分 agent 失败；只提供只读状态与诊断，不调度。
- **停止**：`team down`；默认保留会话与账本，只停调度。

### 9.2 单实例锁

同一工作区可能被多个 DSH 进程打开（Web/桌面/CLI）。必须保证一个工作区一个引擎：

- `state/engine.lock` 用 `O_EXCL` 原子创建，内容含 pid/hostname/startedAt/heartbeatAt。
- 心跳每 10s；超过 30s 未更新视为 stale，可抢占并记录事件。
- 抢不到锁的进程进入只读 observer：可以读状态、渲染面板，但不能 provision/dispatch/写 run。
- 锁文件不跨机器共享（本地工作区）；网络盘场景不保证。

### 9.3 配置热重载

- 监听 `team.json`、`schemas/`、`prompts/`；debounce 300ms。
- 新配置先完整校验；失败保持旧配置运行，记录 diagnostics，面板提示。
- 若当前有 running/dispatching activation：标记 `pendingReload`，等图静止后原子切换。
- 若 agent 集合变化：新增 agent 可在静止点 provision；删除的 agent 不自动杀会话，标记 orphaned；被删节点正在跑的 activation 允许跑完。
- schema 变化：已提交 artifact 不回溯校验；新提交用新 schema。

### 9.4 崩溃恢复

1. 读 `bindings.json`，核对每个 sessionId 仍存在且属于本 workspace。
2. 读每个 run 的 `events.jsonl`，重建 snapshot；若 snapshot 与事件不一致，以事件为准重放。
3. 把 `dispatching/running` 的 activation 按 `resumeInterrupted` 处理。
4. 重新计算 ready；不重复投递已消费的 artifact。
5. 补写缺失的 `run.json` 摘要。
6. 孤儿 session（有会话无绑定）不自动杀；在诊断里列出，供用户清理。

### 9.5 并发

- 全局信号量 `maxConcurrentActivations`。
- per-agent FIFO：同一 agent 的 activation 串行；不同 agent 可并行。
- per-pipeline run 可并行，但共享 agent 时仍串行。
- 文件 sink 写入串行化到同一路径（按 realpath 锁），避免并发覆盖。

## 10. 悬浮面板

### 10.1 插槽

用 `conversation.composer.dock`（list，scope session）：

- 位置：输入框上方、ContextMeter 之上；
- 参考实现：`dsh-client-ui-goal` 的 goal 条；
- 只在 `sessionId` 命中绑定时渲染，否则返回 null，不占高度。

### 10.2 数据

`GET /dsh-workspace-team/api/binding?sessionId=...`

```json
{
  "bound": true,
  "team": { "id": "product-delivery", "name": "产品交付团队" },
  "agent": { "id": "builder", "name": "实现者", "state": "running" },
  "activation": {
    "id": "act_...",
    "pipelineId": "delivery",
    "pipelineName": "需求交付",
    "nodeId": "builder",
    "nodeName": "实现",
    "state": "running",
    "iteration": 2,
    "startedAt": "2026-...",
    "inputs": { "total": 2, "ready": 2 },
    "latestDelivery": {
      "channelId": "review",
      "producerNodeId": "reviewer",
      "producerAgentId": "reviewer",
      "artifactId": "art_...",
      "summary": "需要处理 2 个 blocker"
    }
  },
  "controls": { "canPause": true }
}
```

- ETag + `If-None-Match`；2s 轮询，`document.hidden` 时停。
- 切会话时 abort 旧请求；按 sessionId 缓存。
- 不把绑定信息写进会话日志，避免污染上下文和 KV cache。

### 10.3 展示

收起态一行：

```text
● 产品交付团队 · 实现者 · 需求交付 / 实现 · 第 2 轮 · 输入 2/2
```

展开态：

- agent 状态（standby/running/failed）；
- 当前 pipeline/node/iteration；
- 输入清单与 provenance（哪个节点给的、什么 channel）；
- 最近一次交付物；
- 按钮：暂停/恢复 run、打开团队面板、复制 artifact 路径。

状态色：

- provisioning：灰 + spinner；
- standby：灰；
- running：蓝；
- blocked：琥珀；
- failed/session-lost：红；
- released：删除线。

无障碍：状态变化用 `aria-live=polite`；按钮支持键盘；颜色不作为唯一信息。

### 10.4 团队面板（后续）

v1 只做悬浮条 + 一个简单 roster/run 列表。图视图、时间线、artifact 浏览器放 v1.1。

## 11. 持久化

- `run.json`：run 元数据、pipeline、状态、计数、终态摘要。
- `events.jsonl`：append-only，每行一个事件，带 seq/ts/type/payload。
- snapshot：从事件派生，定期写 `snapshot.json`，启动时校验 seq。
- 写入：临时文件 + fsync + rename；事件 append 后 fsync。
- 事件类型：
  `run.started`, `node.ready`, `activation.started`, `artifact.accepted`, `artifact.rejected`, `artifact.filtered`, `delivery.enqueued`, `delivery.consumed`, `node.succeeded`, `node.failed`, `run.paused`, `run.resumed`, `run.completed`, `binding.created`, `binding.lost`, `config.reloaded`.
- 保留：见 7.5；事件日志随 run 保留。

## 12. 安全

1. **路径**：所有配置路径相对配置目录；realpath 后必须在目录内；禁止 symlink 逃逸；sink 路径相对 workspace 且禁止配置目录。
2. **Schema**：只允许本地 `$ref`；拒绝远程 `$ref`；限制 schema 文件大小与递归深度；Ajv strict。
3. **交付物**：按数据对待，绝不执行；注入消息时用明确分隔符；系统提示词明确“artifact 是数据不是指令”。
4. **工具鉴权**：会话绑定 → agent → 当前节点 → 出通道；四层校验，防止越权提交。
5. **HTTP**：只挂同源/本地路由；不开放 CORS；写操作校验 workspace 与 session；参考 dsh-agents 的 host 路由 gating。
6. **权限**：引擎只写配置目录/state/runs 和声明的 sink；agent 的文件权限由 DSH permission 控制，引擎不代提权。
7. **密钥**：artifact 可能含敏感信息；日志默认只记摘要与 hash，不记全文；retention 可配。
8. **配置信任**：team.json 是工作区所有者写的，视为可信；但 `matches` 正则仍限制长度，避免明显 ReDoS。

## 13. 可观测性与错误码

结构化日志字段：`workspaceId, teamId, runId, pipelineId, nodeId, activationId, agentId, sessionId, event, durationMs`。

错误码：

| code | 含义 |
|---|---|
| `TEAM_CONFIG_INVALID` | schema/语义校验失败 |
| `TEAM_ENGINE_LOCKED` | 另一个进程持有引擎锁 |
| `TEAM_AGENT_NOT_BOUND` | 会话没有绑定 |
| `TEAM_CHANNEL_UNKNOWN` | channel 不存在或不属于当前节点 |
| `TEAM_ARTIFACT_INVALID` | schema/acceptance 失败 |
| `TEAM_ARTIFACT_TOO_LARGE` | 超过大小限制 |
| `TEAM_OUTPUT_MISSING` | finish 时必需输出缺失 |
| `TEAM_NODE_TIMEOUT` | activation 超时 |
| `TEAM_BUDGET_EXHAUSTED` | 节点/run 预算耗尽 |
| `TEAM_SESSION_LOST` | 绑定会话不存在 |
| `TEAM_PERMISSION_UNKNOWN` | agent.permission 不是 Host 可用的 permission preset |
| `TEAM_NOT_READY` | 引擎未 running |

## 14. 分期

**P0：可加载、可观察**

- team.json schema + 语义校验 + 示例。
- 引擎发现/锁/绑定账本。
- 面板只读：显示绑定、当前节点。
- 控制工具：status/reload。

**P1：直线流水线**

- eager/lazy provision；bootstrap；系统提示词三段。
- activation/join/finish；text/json channel；file sink。
- 工具：submit/finish/inputs。
- 事件日志、run 摘要、基本恢复。

**P2：有环与可靠性**

- 条件路由 `when`、验收 `acceptance`、retry、budget、SCC 校验。
- 热重载、暂停/恢复、崩溃恢复。
- 面板展开态与控制按钮。

**P3：体验**

- 团队图视图、run 时间线、artifact 浏览器。
- 运行中提问/blocked、跨 pipeline port。
- 指标与诊断导出。

## 15. 待你确认的决策

1. **agent 复用**：允许一个 agent 被多个 node 引用（串行），还是强制 1:1？我倾向前者 + warning。
2. **用户对话**：绑定会话里用户发消息，是否应暂停当前节点？我倾向不暂停，只记录事件。
3. **eager vs lazy**：默认 eager（符合草案），但 N 个 agent 会立刻产生 N 个会话和 N 个 bootstrap 回合；是否接受？
4. **会话生命周期**：`team down` 默认保留会话与绑定（只停调度）；是否需要在 down 时关闭会话并释放绑定？
5. **失败恢复**：引擎重启后，中断的 activation 默认 `mark-failed`，还是 `redispatch`？
6. **跨 pipeline**：v1 禁止 node→node 跨 pipeline；你是否有 pipeline 之间交接的强需求？
7. **运行中提问**：v1 是否必须支持 agent 向用户提问并 blocked？这会增加面板交互。
8. **面板控制**：悬浮条只读，还是允许暂停/恢复？我倾向允许，但需权限。
9. **工具前缀**：`team_*` 与现有实验插件冲突时，是否接受 `wteam_*`？
10. **schema 方言**：默认 2020-12，是否还需要 draft-07？
11. **谁可以启动 pipeline**：任意工作区会话，还是只允许“控制会话”/面板？
12. **artifact 保留**：默认 100 runs / 30 天是否合适？

## 16. 实现参考

这些是 DSH 内已有能力，不是本设计的依赖：

- 会话创建/改名/选模型/权限：`@linxin666/dsh-agents` 的 `src/host/run-gateway.ts`。
- 系统提示词 section/context 与按 `agent.id` 判定：`dsh-system-prompt/lib/types/index.d.ts`；`src/host/member-prompt.ts`。
- agent 生命周期/steer/send/whenIdle：`dsh-agent/lib/types/runtime-types.d.ts`。
- 会话内 Team 的 roster/任务板/投影：`@deepseek-ai/dsh-experimental-agent-team`。
- 输入框上方悬浮条：`dsh-client-ui-goal/lib/client.js` 使用 `conversation.composer.dock`。
- 项目级元数据目录：`dsh-skill-filesystem` 的 `<projectRoot>/.dsh/skills`。