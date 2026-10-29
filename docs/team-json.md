# team.json 字段规范（v1）

> 状态：设计草案。机器可读定义见 [schema/team.schema.json](../schema/team.schema.json)，完整示例见 [examples/team.json](../examples/team.json)。
>
> 本文回答三个问题：**每个字段是什么意思、默认值是什么、加载器在运行时怎么用它。**

## 1. 文件位置与加载

一个工作区最多一个团队。配置文件固定为：

```text
<workspace>/.dsh/.dsh-workspace-team/team.json
```

同目录下可选：

```text
.dsh/.dsh-workspace-team/
├── team.json
├── schemas/           # channel 引用的 JSON Schema
├── prompts/           # agent / node 引用的提示词文件
├── state/             # 运行时状态（bindings、engine lock 等）
└── runs/              # 每次 pipeline run 的交付物与事件日志
```

- `team.json`、`schemas/`、`prompts/` 是**源文件**，建议提交到 git。
- `state/`、`runs/` 是**运行时产物**，建议 gitignore。
- `team.json` 内所有 `file` 路径都相对 `.dsh/.dsh-workspace-team/` 解析，并做路径逃逸检查。
- `external file sink` 的 `path` 是例外：它相对**工作区根目录**解析。

加载顺序：读取 JSON → JSON Schema 校验 → 语义校验（见第 8 节）→ 编译交付物 Schema → 解析提示词文件 → 构建图 → 启动/重载引擎。任何一步失败都不会部分生效。

## 2. 顶层结构

```json
{
  "schemaVersion": 1,
  "id": "product-delivery",
  "name": "产品交付团队",
  "description": "可选",
  "settings": {},
  "agents": [],
  "channels": [],
  "pipelines": []
}
```

| 字段              | 类型   | 必填 | 说明                                                 |
| ----------------- | ------ | ---- | ---------------------------------------------------- |
| `schemaVersion` | `1`  | 是   | 目前只接受 1。破坏性变更递增，加载器负责迁移或拒绝。 |
| `id`            | id     | 是   | 团队 id，小写 kebab-case，工作区内唯一。             |
| `name`          | string | 是   | 展示名。                                             |
| `description`   | string | 否   | 展示与系统提示词用，不参与调度。                     |
| `settings`      | object | 否   | 引擎、存储、会话、人类对话策略。                     |
| `agents`        | array  | 是   | 至少 1 个。                                          |
| `channels`      | array  | 是   | 至少 1 个。channel 就是图的边。                      |
| `pipelines`     | array  | 是   | 至少 1 个。                                          |

**没有单独的 `edges` 数组。** channel 既是交接契约，也是有向边；node 的入通道/出通道由 channel 的 `from`/`to` 反向推导，避免三处重复。

## 3. settings

```json
{
  "engine": {
    "provisioning": "eager",
    "maxConcurrentActivations": 4,
    "defaultNodeTimeoutMs": 1800000,
    "idleGraceMs": 60000,
    "resumeInterrupted": "mark-failed"
  },
  "storage": {
    "maxArtifactBytes": 1048576,
    "maxInlineBytes": 65536,
    "retainRuns": 100,
    "retainDays": 30
  },
  "session": {
    "titleTemplate": "{{team.name}} / {{agent.name}}"
  },
  "humanChat": "allow"
}
```

| 字段                                | 类型                                           | 默认                               | 说明                                                                                         |
| ----------------------------------- | ---------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `engine.provisioning`             | `eager` \| `lazy`                          | `eager`                          | eager：`team up` 时初始化全部 agent 会话；lazy：节点第一次激活时才建会话。                 |
| `engine.maxConcurrentActivations` | int 1–32                                      | `4`                              | 引擎全局并发 activation 上限。                                                               |
| `engine.defaultNodeTimeoutMs`     | int                                            | `1800000`                        | node 未配置 `timeoutMs` 时的超时。                                                         |
| `engine.idleGraceMs`              | int                                            | `60000`                          | agent 回合结束但未 `team_finish` 时，先提醒；超过该时间判失败。                            |
| `engine.resumeInterrupted`        | `never` \| `redispatch` \| `mark-failed` | `mark-failed`                    | 引擎重启时如何处理中断的 activation。                                                        |
| `storage.maxArtifactBytes`        | int                                            | `1048576`                        | 单个交付物硬上限，channel 的 `maxBytes` 不得超过它。                                       |
| `storage.maxInlineBytes`          | int                                            | `65536`                          | 注入 activation 消息的内联内容上限。                                                         |
| `storage.retainRuns`              | int                                            | `100`                            | 最多保留多少次 run 的产物。                                                                  |
| `storage.retainDays`              | int                                            | 无                                 | 产物保留天数；与 retainRuns 先到先删。                                                       |
| `session.titleTemplate`           | string                                         | `{{team.name}} / {{agent.name}}` | 创建 agent 会话时的标题模板。                                                                |
| `humanChat`                       | `allow` \| `deny` \| `steer`             | `allow`                          | 用户直接和绑定会话对话的策略。steer 表示用户消息作为 steer 注入当前 activation，不另起任务。 |

## 4. agents

```json
{
  "id": "analyst",
  "name": "分析师",
  "role": "需求分析与规格撰写",
  "description": "可选",
  "preset": "local/team-analyst",
  "permission": "workspace-write",
  "model": { "provider": "deepseek", "model": "deepseek-chat", "reasoningEffort": "high" },
  "systemPrompt": { "file": "prompts/analyst.md" },
  "session": { "title": "{{team.name}} / {{agent.name}}" },
  "bootstrap": { "mode": "wake", "message": "可选补充说明" },
  "tags": ["需求"]
}
```

| 字段                  | 类型                   | 必填 | 默认              | 说明                                                                                                                                                                 |
| --------------------- | ---------------------- | ---- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                | id                     | 是   | —                | 团队内唯一。                                                                                                                                                         |
| `name`              | string                 | 是   | —                | 展示名；同名不禁止，但 id 必须唯一。                                                                                                                                 |
| `role`              | string                 | 是   | —                | 一句话角色，进入 roster。                                                                                                                                            |
| `description`       | string                 | 否   | —                | 更长的职责说明，进入 roster。                                                                                                                                        |
| `preset`            | string                 | 否   | 部署默认          | DSH agent preset id。preset 决定工具集、基础系统提示词、默认权限。                                                                                                   |
| `permission`        | string                 | 否   | preset 的权限     | DSH 会话 permission preset 的**名称**（如 `read-only` / `workspace-write` / `danger-full-access`，也可由部署自定义）。preset 解析为 sandbox + approval。 |
| `model`             | object                 | 否   | 会话默认          | `model` 必填；`provider`、`reasoningEffort` 可选。                                                                                                             |
| `systemPrompt`      | textSource             | 否   | 空                | agent 的角色提示词；文件相对配置目录。                                                                                                                               |
| `session.title`     | string                 | 否   | settings 里的模板 | 该 agent 的会话标题覆盖；每个 agent 恰好一个会话。                                                                                                                   |
| `bootstrap.mode`    | `wake` \| `silent` | 否   | `wake`          | wake：初始化时发 standby 消息并让 agent 回 READY；silent：只写系统提示词，不产生回合。                                                                               |
| `bootstrap.message` | string                 | 否   | —                | 追加到默认 standby 消息之后。                                                                                                                                        |
| `tags`              | string[]               | 否   | —                | 仅展示/筛选。                                                                                                                                                        |

**textSource**：`{ "inline": "..." }` 或 `{ "file": "prompts/x.md" }`，二选一。

**一个 agent 一个会话**：agent 与真实 DSH 会话是 1:1，不提供 per-run 会话。agent 被多个 node 复用时，复用的仍是同一个会话（因而上下文延续），激活按 per-agent FIFO 串行。若需要运行隔离，请定义独立 agent，而不是给同一 agent 开多个会话。

**permission 是 preset 名，不是 sandbox 枚举**：DSH 的会话权限由部署的 permission preset 表定义，每个 preset 解析为 `{ sandbox, approval }`。team.json 只引用 preset 名称，不复制 sandbox/approval 组合；本部署常见名称是 `read-only` / `workspace-write` / `danger-full-access`，但 profile 可以增加自定义 preset。`auto` 仅在部署启用 Auto 集成时可用；`custom` 是派生状态，不能作为配置值。加载器在 Host 内用 `permissionPresets` catalog 解析，未知名称拒绝 provision，不静默降级。

## 5. channels

channel 是**带类型契约的有向边**。`from` 是生产者，`to` 是消费者。

```json
{
  "id": "spec",
  "name": "需求规格",
  "from": { "kind": "node", "pipelineId": "delivery", "nodeId": "analyst" },
  "to":   { "kind": "node", "pipelineId": "delivery", "nodeId": "builder" },
  "artifact": {
    "kind": "json",
    "schema": "schemas/spec.schema.json",
    "schemaDialect": "2020-12",
    "maxBytes": 131072
  },
  "required": true,
  "acceptance": [
    { "pointer": "/acceptanceCriteria", "op": "min-length", "length": 1 }
  ],
  "when": [],
  "delivery": {
    "required": true,
    "timing": "on-activate",
    "inline": "auto",
    "maxInlineBytes": 65536
  },
  "retention": { "keepLast": 10 }
}
```

| 字段                                  | 类型                               | 必填 | 默认            | 说明                                                                                                     |
| ------------------------------------- | ---------------------------------- | ---- | --------------- | -------------------------------------------------------------------------------------------------------- |
| `id`                                | id                                 | 是   | —              | 团队内唯一。                                                                                             |
| `name` / `description`            | string                             | 否   | —              | 展示与投递消息用。                                                                                       |
| `enabled`                           | boolean                            | 否   | `true`        | false 时该边不参与调度，但配置仍保留。                                                                   |
| `from`                              | producerParty                      | 是   | —              | 生产者：node 或 external/user。                                                                          |
| `to`                                | consumerParty                      | 是   | —              | 消费者：node 或 external/file。                                                                          |
| `artifact`                          | artifact                           | 是   | —              | 交接物契约。                                                                                             |
| `required`                          | boolean                            | 否   | `true`        | **输出义务**：生产者 node 在 `team_finish` 前必须在该通道成功提交过交付物。external 生产者忽略。 |
| `acceptance`                        | predicate[]                        | 否   | `[]`          | **合格性**：不满足则拒绝提交，不产生 delivery。                                                    |
| `when`                              | predicate[]                        | 否   | `[]`          | **路由**：合格后才评估；全部满足才触发下游。空数组=总是触发。                                      |
| `delivery.required`                 | boolean                            | 否   | `true`        | **输入义务**：该通道是否是消费者 join 的必需输入。                                                 |
| `delivery.timing`                   | `on-activate` \| `immediate`   | 否   | `on-activate` | on-activate：随 activation 一起投递；immediate：合格即尝试 steer/send 给消费者。                         |
| `delivery.inline`                   | `auto` \| `always` \| `path` | 否   | `auto`        | 注入消息时是否内联内容。                                                                                 |
| `delivery.maxInlineBytes`           | int                                | 否   | settings 值     | 单通道内联上限。                                                                                         |
| `retention.keepLast` / `keepDays` | int                                | 否   | —              | 该通道交付物保留策略。                                                                                   |

### 5.1 producerParty

```json
{ "kind": "node", "pipelineId": "delivery", "nodeId": "analyst" }
```

或：

```json
{ "kind": "external", "source": "user" }
```

`external/user` 只用于 pipeline 启动时注入 brief。

### 5.2 consumerParty

```json
{ "kind": "node", "pipelineId": "delivery", "nodeId": "builder" }
```

或：

```json
{ "kind": "external", "sink": "file", "path": "docs/final-report.md", "overwrite": true }
```

file sink 的 `path` 相对工作区根目录；引擎在交付物被接受后用原子写落盘。禁止写到 `.dsh/.dsh-workspace-team/` 内。v1 只支持 text 落盘；json 交付物请先转成文本，或等 v2 的文件 sink 类型。

**v1 限制**：`from` 和 `to` 如果都是 node，必须属于同一个 pipeline。跨 pipeline 的边留到后续版本。

### 5.3 artifact

| 字段                        | 类型                        | 必填      | 说明                                                              |
| --------------------------- | --------------------------- | --------- | ----------------------------------------------------------------- |
| `kind`                    | `text` \| `json`        | 是        | 交付物类型。                                                      |
| `schema`                  | filePath                    | json 必填 | JSON Schema 文件，相对配置目录。text 不允许该字段。               |
| `schemaDialect`           | `2020-12` \| `draft-07` | 否        | 默认 `2020-12`。                                                |
| `mimeType`                | string                      | 否        | text 的提示性 MIME，如 `text/markdown`；不参与校验。            |
| `minBytes` / `maxBytes` | int                         | 否        | 字节数边界；maxBytes 不得超过 settings.storage.maxArtifactBytes。 |
| `title`                   | string                      | 否        | 展示名。                                                          |

JSON Schema 只允许本地 `$ref`，加载时会拒绝远程 `$ref` 和指向配置目录之外的引用。

### 5.4 acceptance / when predicate

```json
{ "pointer": "/status", "op": "eq", "value": "changes_requested" }
```

`pointer` 是 RFC 6901 JSON Pointer。text 交付物只允许空指针 `""`。

| op                              | 额外字段          | 语义                            |
| ------------------------------- | ----------------- | ------------------------------- |
| `eq` / `neq`                | `value`         | 深比较相等/不等。               |
| `in` / `not-in`             | `value` (array) | 值在/不在数组中。               |
| `exists` / `not-exists`     | —                | 指针存在/不存在。               |
| `matches`                     | `pattern`       | JS 正则匹配；pattern 长度受限。 |
| `min-length` / `max-length` | `length`        | 字符串长度或数组元素数。        |
| `min` / `max`               | `number`        | 数值边界。                      |

**acceptance 与 when 的区别**：acceptance 决定“这份交付物合不合格”，不合格会被工具拒绝、agent 可以修正后重提；when 决定“合格交付物要不要触发下游”，不满足时仍入库、记录为 filtered，但不产生 delivery。二者都不要拿来做权限判断。

## 6. pipelines

```json
{
  "id": "delivery",
  "name": "需求交付",
  "enabled": true,
  "start": {
    "mode": "manual",
    "entryNodes": ["analyst"],
    "briefChannel": "brief"
  },
  "nodes": [],
  "completion": {
    "mode": "all-terminal",
    "terminalNodes": ["reviewer"]
  },
  "budget": {
    "maxNodeRuns": 20,
    "maxWallClockMs": 7200000,
    "maxArtifacts": 40
  },
  "layout": { "analyst": { "x": 0, "y": 120 } }
}
```

| 字段                         | 类型                                 | 必填 | 默认             | 说明                                                                                             |
| ---------------------------- | ------------------------------------ | ---- | ---------------- | ------------------------------------------------------------------------------------------------ |
| `id`                       | id                                   | 是   | —               | 团队内唯一。                                                                                     |
| `name` / `description`   | string                               | 否   | —               | 展示与 activation 消息用。                                                                       |
| `enabled`                  | boolean                              | 否   | `true`         | false 时不能启动新 run。                                                                         |
| `start.mode`               | `manual` \| `auto`               | 否   | `manual`       | auto：team up 后自动启动一次。                                                                   |
| `start.entryNodes`         | id[]                                 | 是   | —               | 启动时视为已就绪的节点；其必需入通道必须已经没有未满足的 node 生产者（通常只接 external/user）。 |
| `start.briefChannel`       | id                                   | 否   | —               | 用户 brief 注入通道；必须 from external/user，且 to 是 entry node。                              |
| `completion.mode`          | `all-terminal` \| `any-terminal` | 否   | `all-terminal` | 终止节点完成策略。                                                                               |
| `completion.terminalNodes` | id[]                                 | 是   | —               | 终止节点；run 在终止条件满足且图静止时完成。                                                     |
| `budget.maxNodeRuns`       | int                                  | 否   | 引擎默认         | 整个 run 的激活总次数上限。                                                                      |
| `budget.maxWallClockMs`    | int                                  | 否   | 引擎默认         | 整个 run 的墙钟上限。                                                                            |
| `budget.maxArtifacts`      | int                                  | 否   | 引擎默认         | 整个 run 的交付物数量上限。                                                                      |
| `layout`                   | object                               | 否   | —               | 仅 UI 用的节点坐标。                                                                             |

### 6.1 node

```json
{
  "id": "builder",
  "name": "实现",
  "agentId": "builder",
  "instructions": { "inline": "..." },
  "inputs": { "mode": "any" },
  "activation": {
    "maxActivations": 4,
    "retry": { "maxAttempts": 2, "backoffMs": 5000 },
    "onFailure": "fail-pipeline"
  },
  "timeoutMs": 1800000,
  "position": { "x": 280, "y": 120 }
}
```

| 字段                             | 类型                                           | 必填             | 默认              | 说明                                                                    |
| -------------------------------- | ---------------------------------------------- | ---------------- | ----------------- | ----------------------------------------------------------------------- |
| `id`                           | id                                             | 是               | —                | pipeline 内唯一。                                                       |
| `name`                         | string                                         | 否               | —                | 展示名。                                                                |
| `agentId`                      | id                                             | 是               | —                | 必须引用存在的 agent。                                                  |
| `instructions`                 | textSource                                     | 否               | 空                | activation 任务说明；支持第 7 节变量。                                  |
| `inputs.mode`                  | `all` \| `any` \| `quorum`               | 否               | `all`           | join 策略。                                                             |
| `inputs.quorum`                | int                                            | mode=quorum 时是 | —                | 需要多少个入通道就绪。                                                  |
| `activation.maxActivations`    | int                                            | 否               | 无限              | 单次 run 内该节点最多激活几次。有环图必须至少有一个环上节点设置有限值。 |
| `activation.retry.maxAttempts` | int 1–10                                      | 否               | `1`             | 失败后的总尝试次数（含第一次）。                                        |
| `activation.retry.backoffMs`   | int                                            | 否               | `0`             | 重试间隔。                                                              |
| `activation.onFailure`         | `fail-pipeline` \| `continue` \| `retry` | 否               | `fail-pipeline` | 节点失败后的流水线策略。                                                |
| `timeoutMs`                    | int                                            | 否               | settings 默认     | 单次 activation 超时。                                                  |
| `position`                     | point                                          | 否               | layout 中的值     | 仅 UI。                                                                 |

**node 的通道不在 node 上声明**。入通道 = 所有 `to` 指向该 node 的 channel；出通道 = 所有 `from` 指向该 node 的 channel。这样 channel 是唯一事实来源。

### 6.2 零入通道的节点

`inputs.mode = all` 且没有任何必需入通道时，entry node 在 pipeline 启动后立即就绪。这是 `audit` 这类单节点流水线的正常写法。

## 7. 模板变量

`instructions`、agent `systemPrompt`、`session.title` 支持以下变量：

| 变量                                                       | 含义                                       |
| ---------------------------------------------------------- | ------------------------------------------ |
| `{{team.id}}` / `{{team.name}}`                        | 团队。                                     |
| `{{agent.id}}` / `{{agent.name}}` / `{{agent.role}}` | 当前 agent。                               |
| `{{pipeline.id}}` / `{{pipeline.name}}`                | 当前 pipeline。                            |
| `{{node.id}}` / `{{node.name}}`                        | 当前 node。                                |
| `{{run.id}}`                                             | 当前 run。                                 |
| `{{activation.id}}`                                      | 当前 activation。                          |
| `{{activation.iteration}}`                               | 当前节点在本 run 的第几次激活，从 1 开始。 |
| `{{goal}}`                                               | 启动 brief 的纯文本；没有则为空。          |

未知变量在加载时报错，不会静默替换为空。

## 8. 语义校验清单

JSON Schema 只能保证结构。加载器还必须做以下检查；标 **(error)** 的会拒绝加载，标 **(warn)** 的只提示。

1. **(error)** `team.json` 位于 `.dsh/.dsh-workspace-team/`，一个工作区只有一个。
2. **(error)** 所有 agent / channel / pipeline id 唯一；node id 在 pipeline 内唯一。
3. **(error)** `node.agentId` 指向存在的 agent；`from`/`to` 的 pipeline/node 指向存在的节点。
4. **(error)** v1 中 node→node channel 的两端必须在同一 pipeline。
5. **(error)** `start.entryNodes`、`completion.terminalNodes` 指向本 pipeline 的节点。
6. **(error)** `start.briefChannel` 必须 from external/user，且 to 是 entry node。
7. **(error)** 同一 pipeline 内，从 entry 沿 channel 可达所有节点；终止节点可达（否则 warn）。
8. **(error)** 每个 SCC（含自环）必须有界：环上至少一个节点有有限 `maxActivations`，或 pipeline 的 `budget.maxNodeRuns` / `maxWallClockMs` 有限。
9. **(error)** json 通道的 schema 文件存在、可编译、只含本地 `$ref`；text 通道不得有 `schema`。
10. **(error)** 所有 `file` 路径在配置目录内，无 `..`、绝对路径、反斜杠、symlink 逃逸。
11. **(error)** file sink 路径在工作区内，且不在 `.dsh/.dsh-workspace-team/` 内。
12. **(error)** `artifact.minBytes <= maxBytes`，且 `maxBytes <= settings.storage.maxArtifactBytes`。
13. **(error)** `inputs.mode=quorum` 时 `quorum <= 必需入通道数`。
14. **(error)** 每个 `activation.maxActivations` 为正整数；每个 `retry.maxAttempts` 在 1–10。
15. **(warn)** 同一 agent 被多个 node 引用：合法，但 activation 会串行排队。
16. **(warn)** 没有任何 terminal 节点可达的节点；没有任何入通道且未列为 entry 的节点。
17. **(warn)** channel 的 `acceptance`/`when` 在 text 上使用了 `eq` 之类需要 JSON 的 op。
18. **(warn)** `start.mode=auto` 且 entry node 有必需 node 入通道：自动启动可能永远等不到输入。
19. **(error，需 Host 上下文)** 若配置了 `agent.permission`，它必须存在于 Host 的 `permissionPresets` catalog；静态 validator 不加载 profile，跳过这一条。

## 9. 运行时字段映射

| 配置                                 | 运行时行为                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `agent.permission`                 | 创建会话后按 Host 的 permission preset 切换；未知 preset 使 provision 失败。 |
| `channel.acceptance`               | `team_submit_artifact` 时校验；失败返回校验错误，不入库、不投递。          |
| `channel.when`                     | 合格交付物入库后评估；false 记为 filtered，不投递。                          |
| `channel.required`                 | `team_finish` 时检查该节点必需出通道是否都已成功提交。                     |
| `delivery.required`                | 计算节点 join 时，是否必须等这个入通道。                                     |
| `delivery.timing`                  | immediate 时，合格即 steer/send 给消费者；否则等 activation。                |
| `inputs.mode`                      | 决定节点何时 ready。                                                         |
| `activation.maxActivations`        | 每次 run 的节点激活计数上限。                                                |
| `activation.retry` / `onFailure` | 节点失败后的重试与流水线策略。                                               |
| `completion`                       | 终止条件。                                                                   |
| `budget`                           | run 级硬上限；超出后 run 以 `budget_exhausted` 结束。                      |

## 10. 常见建模

**扇出**：一个 node 有多个出通道，分别指向不同下游；每个通道独立校验、独立投递。

**汇合**：一个 node 有多个入通道，`inputs.mode=all`；所有 `delivery.required` 通道都有未消费交付物才激活。

**有环反馈**：reviewer → builder 的 review 通道 + builder → reviewer 的 build-report 通道。必须给环上节点设 `maxActivations`，或给 pipeline 设 `maxNodeRuns`。验收通过/打回的分支用 `when` 区分。

**条件分支**：同一个 node 的多个出通道用互斥的 `when`；不匹配的交付物入库但不投递。

**外部落盘**：`to: external/file`；适合最终报告、审计报告、生成物。写入是原子的，失败会重试并记录。

**人类在环**：`from: external/user` + `start.briefChannel`；用户在启动 run 时提供 brief。运行中的提问通道留到 v1.1。

**跨 pipeline**：v1 不支持 node→node 跨 pipeline；需要时用一个 pipeline 的 terminal 节点 + 另一个 pipeline 的 user brief 手工衔接，或等 v2 的 pipeline port。

## 11. 版本与扩展

- `schemaVersion` 是唯一的格式版本；新增可选字段不升版本，删除/改语义才升。
- 未识别的字段一律报错（`additionalProperties: false`），避免拼写错误静默生效。
- 预留但 v1 不实现的字段：pipeline port、channel 跨 pipeline、node 级 model 覆盖、运行中提问通道、artifact 二进制类型。
- 迁移策略：加载器按 `schemaVersion` 分派迁移函数，迁移后再次跑完整校验；迁移失败拒绝加载并给出原始错误。

## 12. 相关文件

- JSON Schema：[schema/team.schema.json](../schema/team.schema.json)
- 完整示例：[examples/team.json](../examples/team.json)
- 示例交付物 Schema：[examples/schemas/](../examples/schemas/)
- 设计说明：[docs/design.md](./design.md)
- 校验脚本：[scripts/validate-team.mjs](../scripts/validate-team.mjs)
