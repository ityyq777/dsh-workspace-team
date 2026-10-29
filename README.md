# 工作区团队设计草案

工作区级多 agent 团队：一个工作区一个团队，团队由多个 agent、多个有向有环 pipeline、多个带类型契约的 channel 组成；团队引擎把节点调度到真实的 DSH 会话，并在对话输入框上方显示绑定信息。Web UI 默认禁用绑定 worker 的输入框，用户经主 Agent 提建议或回答问题。

当前仓库是**设计稿 + JSON Schema + 可校验示例**，不是可运行插件。

## 读什么

1. [总体设计](docs/总体设计.md) — 图语义、agent 运行态、会话绑定、引擎、面板、持久化、安全、分期。
2. [团队配置文件字段规范](docs/团队配置文件字段规范.md) — `team.json` 逐字段说明、默认值、语义校验清单、建模模式。
3. [人工交互契约](docs/人工交互契约.md) — 推荐主 Agent、建议转达、worker 提问、worker composer 禁用与直接输入观察。
4. [节点激活消息契约](docs/节点激活消息契约.md) — 接收器触发后发给 agent 的 activation 消息契约。
5. [智能体初始化消息契约](docs/智能体初始化消息契约.md) — 初始化 agent 时发给它的 bootstrap 消息契约（worker 与主 Agent 两套模板）。
6. [schema/team.schema.json](schema/team.schema.json) — JSON Schema（draft 2020-12，`additionalProperties: false`）。
7. [examples/team.json](examples/team.json) — 一个可校验的完整例子：4 个用户配置的 agent、2 条 pipeline、6 条 channel，含评审打回环；主 Agent 由引擎自动生成，不写在示例里。
8. [examples/schemas/](examples/schemas/) / [examples/prompts/](examples/prompts/) — 示例交付物 Schema 与提示词。

## 目录

```text
.
├── docs/
│   ├── 总体设计.md
│   ├── 团队配置文件字段规范.md
│   ├── 人工交互契约.md
│   ├── 节点激活消息契约.md
│   └── 智能体初始化消息契约.md
├── schema/
│   └── team.schema.json
├── examples/
│   ├── team.json
│   ├── prompts/analyst.md
│   └── schemas/{spec,build-report,review}.schema.json
├── scripts/
│   └── validate-team.mjs
└── README.md
```

## 部署到工作区

```bash
mkdir -p <workspace>/.dsh/.dsh-workspace-team
cp -R examples/* <workspace>/.dsh/.dsh-workspace-team/
```

示例里的 `$schema` 指向仓库内的 `../schema/team.schema.json`；复制到工作区后请改成实际路径，或删掉该字段（不影响加载）。

## 校验示例

需要 `ajv`：

```bash
npm i -D ajv
node scripts/validate-team.mjs examples/team.json
```

（校验脚本随设计稿提供，用来把“语义校验清单”变成可执行检查；插件实现时应复用同一套规则。）

## 关键设计点

- **channel 就是边，且是 1:1**：消费者是 receiver，不是裸节点；`to` 固定目标（receiver 或 file sink），扇出要建多条 channel。一次 activation 走哪条出通道由 agent 自己选。
- **接收器各自排队**：agent 可以有多个 receiver，每个 receiver 只有一条 `rule` 数组；rule 里所有 channel 的交付物到齐，该 receiver 满足并产生一个 activation。先满足先执行，后满足排队，不按优先级丢弃。
- **验收与路由分离**：`acceptance` 决定交付物合不合格；`when` 决定合格后要不要触发下游。
- **有环必须有界**：SCC 上至少一个节点有有限 `maxActivations`，或 pipeline 有有限预算；否则加载失败。
- **一个 agent 一个会话**：agent ↔ session 1:1，无 per-run 模式；绑定写账本，重启对账；一个 agent 可被多个 node 复用但串行执行。
- **agent preset 可选，缺省 standard**：`agent.preset` 可为任意已安装的 DSH agent preset，团队工具与提示词叠加其上；`agent.permission` 仍是 permission preset 名称（sandbox + approval），两者独立。未知 preset 使 provision 失败 `TEAM_PRESET_UNKNOWN`。
- **activation 带 provenance**：agent 明确知道每份输入来自哪个 pipeline/node/agent/channel。
- **系统提示词四部分**：工作区 `systemPrompt` 只写角色；引擎随后拼接内置团队协议（工具清单与调用方法）和该 agent 的**可用输出通道**（按 placement 从图生成），最后是 roster。node instructions 与输入只出现在 activation 消息里，activation 不列 outputs。
- **输出由 agent 选**：出通道、类型/schema、目标、是否 required 都在系统提示词；agent 按当前情境选 channel，提交时校验 `receiverId`+`channelId`（file 目标只给 `channelId`）。`required` 是完成义务，互斥备选应标 false。
- **面板不污染会话日志**：绑定信息走 Host HTTP 路由，客户端按 sessionId 轮询。
- **推荐主 Agent，UI 禁用 worker 输入框**：Host 不拦截输入；Client 用 DSH 的 `ctx.conversation.blocks` 把绑定 worker 的 composer 置为 inert。建议由主 Agent 转成 Suggestion，worker 提问经主 Agent 代办。API/其他客户端仍可直接对话，引擎只观察并记录摘要。
- **主 Agent 引擎生成**：用户配置的 agent 只能写 `team_role=slave`；引擎初始化时按 `settings.masterAgent` 生成/补齐唯一的 `master`（默认 `team-master`），写入有效配置与绑定账本，不写回 `team.json`。