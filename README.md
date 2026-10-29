# dsh-workspace-team（设计草案）

工作区级多 agent 团队：一个工作区一个团队，团队由多个 agent、多个有向有环 pipeline、多个带类型契约的 channel 组成；团队引擎把节点调度到真实的 DSH agent 会话，并在对话输入框上方显示绑定信息。

当前仓库是**设计稿 + JSON Schema + 可校验示例**，不是可运行插件。

## 读什么

1. [docs/design.md](docs/design.md) — 总体设计：图语义、agent 运行态、会话绑定、引擎、面板、持久化、安全、分期。
2. [docs/team-json.md](docs/team-json.md) — `team.json` 逐字段说明、默认值、语义校验清单、建模模式。
3. [schema/team.schema.json](schema/team.schema.json) — JSON Schema（draft 2020-12，`additionalProperties: false`）。
4. [examples/team.json](examples/team.json) — 一个可校验的完整例子：4 个 agent、2 条 pipeline、6 条 channel，含评审打回环。
5. [examples/schemas/](examples/schemas/) / [examples/prompts/](examples/prompts/) — 示例交付物 Schema 与提示词。

## 目录

```text
.
├── docs/
│   ├── design.md
│   └── team-json.md
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

- **channel 就是边**：node 的入/出通道由 channel 的 `from`/`to` 推导，不在 node 上重复声明。
- **验收与路由分离**：`acceptance` 决定交付物合不合格；`when` 决定合格后要不要触发下游。
- **有环必须有界**：SCC 上至少一个节点有有限 `maxActivations`，或 pipeline 有有限预算；否则加载失败。
- **一个 agent 一个会话**：agent ↔ session 1:1，无 per-run 模式；绑定写账本，重启对账；一个 agent 可被多个 node 复用但串行执行。
- **agent preset 固定 standard**：团队不提供 preset 选择，每个 agent 在 team.json 里记录 `"preset": "standard"`（schema `const` 强制）；`agent.permission` 仍是 permission preset 名称（sandbox + approval），两者独立。
- **activation 带 provenance**：agent 明确知道每份输入来自哪个 pipeline/node/agent/channel。
- **系统提示词稳定**：persona/roster/protocol 固定；node instructions 与输入只出现在 activation 消息里。
- **面板不污染会话日志**：绑定信息走 Host HTTP 路由，客户端按 sessionId 轮询。