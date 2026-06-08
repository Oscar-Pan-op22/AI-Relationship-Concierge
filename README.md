# 同频

`同频` 是一个以 `Twin` 为核心的关系筛选与透明预沟通原型。

当前仓库运行的是 `Phase 2`：双真实用户、双侧 `Twin`、自动化 `Twin-Twin` 预沟通、敏感议题授权、人工接管与阶段总结。

## 当前能力

### 1. 账号与 Twin

- 注册、登录、登出
- 每个用户只有 1 个当前 `Twin`
- 每次保存 `Twin` 都会生成内部版本快照
- `Twin` 支持：
  - 关系目标
  - 偏好城市
  - 沟通风格
  - 结婚节奏
  - 孩子与生育态度
  - 家庭边界
  - 财务观
  - 必须满足项 / 硬性雷区
  - 敏感议题授权
  - 结构化现实条件

### 2. Phase 1 初筛

- 基于当前 `Twin` 生成匹配报告
- 输出：
  - `Twin` 画像摘要
  - shortlist
  - 现实条件摘要
  - 画像缺口
  - 下一步建议
- 报告是 **Twin 版本快照**
  - 修改 `Twin` 后，旧报告不会自动更新
  - 需要重新生成报告，才会读取最新 `Twin`

### 3. Phase 2 真实用户预沟通

- 真实用户之间建立双边匹配
- 发起、接受和拒绝预沟通邀请
- `Twin-Twin` 自动推进非敏感议题
- 敏感议题逐题授权
- 人工补充、真人直接发消息、手动结束推进
- 会话详情页展示透明线程、阶段总结、议题进展和对方已确认事实

### 4. 阶段总结

- 会话内会生成阶段报告 `stage report`
- 阶段总结默认按 **当前查看者视角** 展示
  - 看到的是“关于对方”的总结
- 总结格式已统一为：
  - `议题：结论；议题：结论`
- 总结覆盖对方所有已确认事实，不只看当前 round scope

### 5. LLM 接入

- 默认走 `vLLM OpenAI-compatible API`
- 已实现：
  - `chat.completions` 调用
  - JSON 提取与修复
  - schema 校验
  - fallback / retry
  - telemetry 日志
- 纯模型不稳定类失败会优先走静默恢复，而不是立即可见暂停

## 技术栈

- 前端：原生 HTML / CSS / JavaScript
- 后端：Node.js 原生 HTTP 服务
- 数据库：SQLite
- 模型接入：vLLM OpenAI-compatible API

## 目录结构

```text
public/
  auth.html / auth.js              登录与注册
  index.html / app.js              当前 Twin 编辑页
  reports.html / reports.js        历史匹配报告列表
  report.html / report.js          单条匹配报告详情
  matches.html / matches.js        可发起对象页
  sessions.html / sessions.js      所有会话
  inbox.html / inbox.js            待办箱
  prechat-session.html / .js       预沟通会话详情
  fact-utils.js                    会话事实净化与去重
  common.js                        前端公共工具
  styles.css                       全局样式

src/
  server.js                        HTTP 服务与 API 路由
  lib/
    auth.js                        登录与 session
    constants.js                   常量与枚举
    database.js                    SQLite 持久化
    matchingEngine.js              Phase 1 匹配引擎
    matchService.js                Phase 2 匹配构建
    phase2MatchEngine.js           双边匹配评分与公开快照
    prechatService.js              预沟通状态机与自动恢复
    llmAdapter.js                  vLLM / OpenAI-compatible 适配层
    llmSchemas.js                  模型输出 schema 校验
    llmTelemetry.js                LLM telemetry
    mockCandidatePool.js           Phase 1 mock 候选池

scripts/
  test_vllm_connectivity.py        vLLM OpenAI-compatible 连通性测试
  reset_and_restart_prechat.py     清空历史预沟通并重启 Twin-Twin 自动化
  regenerate_prechat_summaries.py  重算阶段总结，不推进预沟通
  restart_prechat_helper.mjs       重启预沟通 helper
  regenerate_prechat_summaries_helper.mjs
                                   阶段总结重算 helper
  recover_mirror_quality_pauses.js 历史 mirror quality pause 恢复脚本
  repair-polluted-cities.js        历史 cities 脏数据修复脚本

test/
  *.test.js                        单元与集成测试
```

## 本地启动

```bash
npm.cmd start
```

默认地址：

```text
http://localhost:3000
```

健康检查：

```text
GET /api/health
```

## 测试

跑全量测试：

```bash
npm.cmd test
```

或：

```bash
node --test
```

## 关键页面

- `/`：当前 `Twin` 编辑页
- `/reports.html`：历史匹配报告列表
- `/report.html?reportId=...`：单条匹配报告
- `/matches.html`：可发起对象
- `/sessions.html`：所有预沟通会话
- `/inbox.html`：待办箱
- `/prechat-session.html?sessionId=...`：预沟通会话详情

## 常用维护脚本

### 1. 测试 vLLM 连通性

```bash
python scripts\test_vllm_connectivity.py --base-url http://100.91.101.3:8003/v1 --verbose
```

### 2. 清空历史预沟通并重启

本地服务已启动时，优先异步调用服务端接口：

```bash
python scripts\reset_and_restart_prechat.py --server-async
```

如果本地服务不可用，脚本会退回本地清库 + helper 重启。

### 3. 重算阶段总结，不影响 Twin-Twin 预沟通

重算单个会话：

```bash
python scripts\regenerate_prechat_summaries.py --session-id <SESSION_ID>
```

重算全部会话：

```bash
python scripts\regenerate_prechat_summaries.py --all
```

## LLM 环境变量

当前默认值已经指向现有 vLLM，也可以覆盖：

```bash
LLM_PROVIDER=vllm_openai
LLM_BASE_URL=http://100.91.101.3:8003/v1
LLM_MODEL=Qwen3.6-35B-A3B-FP8
LLM_API_KEY=EMPTY
LLM_TIMEOUT_MS=15000
LLM_MAX_RETRIES=1
```

## 数据文件

运行时默认写到 `data/`：

- `tongpin.sqlite`
- `llm-events.jsonl`
- `prechat-reset-jobs/`

常见备份文件也会落在 `data/`，例如：

- `tongpin.sqlite.bak-*`

## 当前行为约定

### 报告与版本

- `match report` 是 `Twin` 快照，不会自动追随最新画像
- 重新生成报告后，才会读取当前 `Twin`

### 阶段总结视角

- `session list`
- `inbox session_review`
- `session detail`

以上页面里的阶段总结，默认都应展示“关于对方”的总结，而不是“关于自己”的总结。

### 预沟通自动化

- 非敏感议题自动推进
- 敏感议题先授权
- 纯模型不稳定优先静默恢复
- 业务性暂停仍保留可见待办

## 已知边界

这是一个 `Phase 2` 原型，不是生产系统。

已完成：

- 真实登录
- Twin 建档
- Phase 1 初筛报告
- 真实用户 shortlist
- 双边匹配
- Twin-Twin 预沟通
- 敏感议题授权
- 会话 / 待办管理
- 人工接管

未完成：

- 生产级账号体系
- 多端实时同步
- 文件与头像上传
- 完整审核后台
- 生产级风控 / 监控 / 运维体系

## 备注

- 仓库里仍保留少量历史兼容和运行时自愈逻辑，用于吸收旧数据库里的脏 turn、乱码文本和错误 metadata。
- 当前主流程与用户可见页面以 UTF-8 中文为准。
