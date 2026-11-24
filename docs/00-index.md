---
title: 文档索引 —— 场景空间设计器
type: 索引
tags: [场景空间设计器, 文档索引]
created: 2026-11-24
updated: 2026-11-25
author: demo
status: 现行
project: scene-space-designer
---

# 文档索引

## 1 公开仓随附的文档

| 文档 | 讲什么 | 什么时候读 |
| --- | --- | --- |
| [`../README.md`](../README.md) | 定位、30 秒启动、演示数据、许可 | 第一次打开这个仓库 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 分层、目录、数据组织、内核等价的保证方式 | 想知道「为什么前端能离线判、后端又必须是唯一裁判」 |
| [`KERNEL.md`](KERNEL.md) | 规则内核：判据、参数表、门语义、净空、自动摆位 | 要改一条业务规则 |
| [`MODEL-PIPELINE.md`](MODEL-PIPELINE.md) | 模型 → LOD / 缩略图 / 实测尺寸的管线 | 要接入新模型 |
| [`UI-SPEC.md`](UI-SPEC.md) | 界面规范：角标、文字与颜色、错误话术 | 要改界面或加一个角标 |
| [`RUNBOOK.md`](RUNBOOK.md) | 起停、排障、验收、打包、迁移 | 跑不起来 / 要部署 |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | 改哪里、怎么验、迁移与提交纪律 | 要动代码 |
| [`DECISIONS.md`](DECISIONS.md) | 「设计决策记录」是什么、读不到时看哪份 | 看到注释里引用它的时候 |

## 2 这个仓库里没有的东西

- **内部设计决策留档**（ADR 形式，含现场部署与验收过程）：不随公开仓发布，说明见 [`DECISIONS.md`](DECISIONS.md)。
- **真实产品模型与目录数据**：仓库里只有合成的演示机型（`DEMO-*`）与一个演示模型。
- **现场脚本**（真机探针、性能采样器、对比度扫描）：属于内部工具，不在这个仓库里。

## 3 怎么读

1. 先看 `README.md` 的「30 秒启动」，把服务跑起来；
2. 想改规则 → `KERNEL.md`；想改界面 → `UI-SPEC.md`；想接入模型 → `MODEL-PIPELINE.md`；
3. 动手之前读一遍 `DEVELOPMENT.md`（迁移纪律、两条铁律、提交口径）；
4. 跑验收：`bash tools/verify/gate.sh`（五步，一条命令）。
