# 同频 Phase 1 工作台

当前这版 `Phase 1` 的目标是：

`用户单侧建档 -> 保存 Twin 档案 -> 从候选库做初筛匹配 -> 输出 shortlist`

它不再要求用户手动录入候选人，而是先围绕用户本人建立 Twin 画像，再从数据库候选池中筛出更适合进入下一阶段的人选。

## 当前已实现

- `Twin 建档`
  - 关系目标
  - 偏好城市
  - 必须满足项与硬性雷区
  - 沟通风格、结婚节奏、孩子态度
  - 家庭边界与财务观
  - 敏感议题授权
- `结构化现实条件层`
  - 本人现实情况：收入、住房、负债、车、父母照护压力等
  - 对对方的现实条件偏好：`ignore / prefer / require / reject`
- `Twin 档案持久化`
  - 保存 Twin 档案
  - 读取已保存档案
  - 基于已保存档案重新匹配
- `候选池初筛匹配`
  - 多维匹配矩阵
  - 结构化现实条件加权
  - 雷区与风险信号识别
  - shortlist 排序
  - 用户画像缺口提示
  - 建议补充的信息
- `SQLite 持久化`
  - `profiles`
  - `candidate_profiles`
  - `match_reports`

## 当前没有实现

- 真实用户注册与登录
- Twin 与候选人的实时预沟通
- 敏感问题自动代问
- 真人接管聊天
- 外部 LLM / API 接入
- 完整匹配网络与审核后台

## 技术结构

- `src/server.js`
  - HTTP 服务与 API 路由
- `src/lib/database.js`
  - SQLite 初始化、候选池 seed、Twin 档案与报告持久化
- `src/lib/matchingEngine.js`
  - Phase 1 匹配引擎
- `src/lib/mockCandidatePool.js`
  - 初始 seed 候选池
- `public/`
  - 建档、档案加载、重新匹配、报告展示界面
- `test/`
  - 匹配引擎与数据库层测试

## 启动

```bash
npm.cmd start
```

打开 `http://localhost:3000`

## 测试

```bash
npm.cmd test
```

## 默认数据文件

- SQLite：`data/tongpin.sqlite`
- 旧的 JSON 报告文件已不再作为主存储使用

## 当前阶段定义

这一版 Phase 1 的重点是：

- 先把 `我是谁、我想找什么、我不能接受什么` 结构化
- 再把这份 Twin 画像持久化成可反复使用的档案
- 然后用数据库候选池做初筛匹配
- 为下一阶段的 `Twin 预沟通 / 敏感信息核实 / 真人接手` 预留稳定输入
