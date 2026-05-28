# 同频

`同频` 是一个以 `Twin` 为核心的关系筛选与预沟通原型。

当前仓库已经从早期的单用户 `Phase 1` 工作台，演进到 `Phase 2` 的双真实用户版本：

- 用户登录后维护自己唯一的当前 `Twin`
- 生成 `Phase 1` 初筛报告与 shortlist
- 在真实用户之间建立双边匹配
- 发起并接受 `Twin-Twin` 透明预沟通
- 对敏感问题做逐题授权
- 在待办箱里处理邀请、授权和人工补充
- 在会话页里查看透明线程，并允许真人直接接管发消息

## 当前能力

### 1. 账号与 Twin

- 最小真实登录：注册、登录、登出
- 每个用户只有 1 个当前 `Twin`
- 每次保存都会生成内部版本快照
- `Twin` 支持：
  - 关系目标
  - 偏好城市
  - 沟通风格
  - 结婚节奏
  - 孩子与生育态度
  - 家庭边界
  - 财务观
  - 敏感议题授权
  - 结构化现实条件

### 2. Phase 1 初筛

- 基于 `Twin` 画像生成匹配报告
- 输出 shortlist、风险点、现实条件摘要、画像缺口和下一步建议
- 支持在报告页确认下一阶段预沟通对象与目标

### 3. Phase 2 预沟通

- 双真实用户匹配
- 透明的 `Twin-Twin` 预沟通线程
- 自动推进非敏感问题
- 敏感问题逐题授权
- 人工补充与模型异常暂停
- “所有会话”与“待办箱”统一管理
- 真人可直接在会话详情页发消息，重新激活已完成会话

### 4. LLM 接入

- 当前默认走 `vLLM OpenAI-compatible API`
- 已实现：
  - `chat.completions` 调用
  - JSON 提取与修复
  - schema 校验
  - retry / fallback
  - telemetry 日志

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
  report.html / report.js          Phase 1 匹配结果页
  matches.html / matches.js        双边匹配页
  inbox.html / inbox.js            待办箱
  sessions.html / sessions.js      所有会话
  prechat-session.html / .js       预沟通会话详情
  styles.css                       全局样式

src/
  server.js                        HTTP 服务与 API 路由
  lib/
    auth.js                        登录与 session
    database.js                    SQLite 持久化
    matchingEngine.js              Phase 1 匹配引擎
    phase2MatchEngine.js           双边匹配逻辑
    prechatService.js              预沟通状态机
    llmAdapter.js                  vLLM / OpenAI-compatible 适配层
    llmSchemas.js                  模型输出 schema 校验
    llmTelemetry.js                调用 telemetry

scripts/
  test_vllm_connectivity.py        vLLM 连通性测试脚本

test/
  *.test.js                        单元与集成测试
```

## 本地启动

```bash
npm.cmd start
```

启动后打开：

```text
http://localhost:3000
```

## 测试

```bash
npm.cmd test
```

## LLM 环境变量

当前默认值已经指向现有 vLLM，但也可以覆盖：

```bash
LLM_PROVIDER=vllm_openai
LLM_BASE_URL=http://100.91.101.3:8003/v1
LLM_MODEL=Qwen3.6-35B-A3B-FP8
LLM_API_KEY=EMPTY
LLM_TIMEOUT_MS=15000
LLM_MAX_RETRIES=1
```

## 数据文件

运行时数据默认写到 `data/`：

- `tongpin.sqlite`
- `llm-events.jsonl`

这些文件都不会提交到 Git。

## 当前状态说明

这个仓库目前是一个 `Phase 2 原型`，已经具备完整主链路，但仍有明确边界：

- 已完成：
  - 真实登录
  - Twin 建档
  - 初筛报告
  - 双边匹配
  - Twin-Twin 预沟通
  - 敏感问题授权
  - 会话与待办管理
- 尚未完成：
  - 生产级账号体系
  - 图片头像上传
  - WebSocket 实时同步
  - 完整真人聊天产品
  - 生产级风控与审核后台

## 说明

仓库里保留了少量历史兼容逻辑，用于识别旧数据库里的坏名称或乱码数据；用户可见页面和主流程代码已经统一清理为 UTF-8 中文。
