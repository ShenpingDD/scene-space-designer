---
title: 文档索引 —— 场景空间设计器
type: 索引
tags: [场景空间设计器, 文档索引, 编号对照]
created: 2026-11-24
updated: 2026-11-24
author: demo
status: 现行
project: scene-space-designer
---

# 文档索引

## 1. 公开仓随附的文档

| 文档 | 讲什么 | 什么时候读 |
| --- | --- | --- |
| [`../README.md`](../README.md) | 定位、30 秒启动、演示数据、许可 | 第一次打开这个仓库 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 分层、目录、数据组织、内核等价的保证方式 | 想知道「为什么前端能离线判、后端又必须是唯一裁判」 |
| [`KERNEL.md`](KERNEL.md) | 规则内核：判据、参数表、门语义、净空、自动摆位 | 要改一条业务规则 |
| [`MODEL-PIPELINE.md`](MODEL-PIPELINE.md) | 模型 → LOD / 缩略图 / 实测尺寸的管线 | 要接入新模型 |
| [`UI-SPEC.md`](UI-SPEC.md) | 界面规范：角标、文字与颜色、错误话术 | 要改界面或加一个角标 |
| [`RUNBOOK.md`](RUNBOOK.md) | 起停、排障、验收、打包、迁移 | 跑不起来 / 要部署 |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | 改哪里、怎么验、迁移与提交纪律 | 要动代码 |

## 2. 代码里的 `docs/NN` 是什么

代码注释与文档正文里会出现 `docs/NN`（例如 `docs/17 §2`、`docs/32 §角标表`）。
那是**内部设计文档的编号锚点**：这个项目的历史决策都留了编号，删掉锚点等于删掉「为什么这么做」的证据。

公开仓**不随附**这 113 份内部文档（它们含现场部署、客户与验收记录）。读到 `docs/NN` 时的正确做法：

1. 按下面的对照表找到主题；
2. 到本目录对应的公开文档里找同一主题的现役表述（架构 → `ARCHITECTURE.md`，判据 → `KERNEL.md`，界面 → `UI-SPEC.md`，运维 → `RUNBOOK.md`，流程 → `DEVELOPMENT.md`）；
3. **不要把锚点当失效链接删掉**。

## 3. 编号对照表

| 编号 | 内部主题（原 slug） | 一句话 |
| --- | --- | --- |
| `docs/00` | `index` | — |
| `docs/01` | `project-review` | 项目评审 |
| `docs/02` | `review-bmad-lens` | BMAD 视角复审 |
| `docs/03` | `review-verification` | 评审证据核验 |
| `docs/04` | `fix-backlog` | 修复待办 |
| `docs/05` | `fix-r1-changelog` | R1 修复变更 |
| `docs/06` | `architecture-baseline` | 架构基线（分层/单租户/存储两档） |
| `docs/07` | `model-delivery-spec` | 模型交付规格 |
| `docs/08` | `r2-extraction-changelog` | R2 抽取变更 |
| `docs/09` | `r3-shell-changelog` | R3 外壳变更 |
| `docs/10` | `r5-model-pipeline` | R5 模型管线 |
| `docs/100` | `columns-ui` | 柱列 UI |
| `docs/101` | `columns-design-review` | 柱列设计评审 |
| `docs/102` | `columns-delivery` | 柱列交付 |
| `docs/103` | `product-hotspots-prd` | 产品热点 PRD |
| `docs/104` | `product-hotspots-ui` | 产品热点 UI |
| `docs/105` | `product-hotspots-architecture` | 产品热点架构 |
| `docs/106` | `product-hotspots-frontend-tech` | 产品热点前端技术 |
| `docs/107` | `product-library-uat2` | 产品库验收（第二轮） |
| `docs/108` | `hotspot-local-bounds` | 热点局部坐标系 |
| `docs/109` | `design-end-home-and-my-schemes` | 设计端首页与我的方案 |
| `docs/11` | `r5-6-3d-changelog` | R5-6 3D 变更 |
| `docs/110` | `uat3-hotspot-data-repair` | 验收第三轮：热点数据修复 |
| `docs/111` | `product-actions-quality` | 产品操作质量 |
| `docs/112` | `demo-animations-and-2d-borders` | 演示动画与 2D 描边 |
| `docs/113` | `demo-hotspots-thumbs-and-wall-bug` | 演示热点/缩略图与墙体缺陷 |
| `docs/12` | `r3-7-door-geometry` | R3-7 开门几何 |
| `docs/13` | `p1-seam-decisions` | P1 接缝决策 |
| `docs/14` | `rule7-door-clearance` | 规则7 开门净空 |
| `docs/15` | `rule-params` | 规则参数 |
| `docs/16` | `clearance-ui` | 净空界面 |
| `docs/17` | `java-kernel-parity` | Java 内核与 JS 逐行等价 |
| `docs/18` | `backend-skeleton` | 后端骨架 |
| `docs/19` | `vscode-guide` | 编辑器使用指南 |

> `docs/75`（性能监控）与 `docs/85`（macOS 验收基建）讲的是内部机器上的采样器与验收装置，
> 公开仓不含这些脚本；正文引用它们时按「内部工具」理解，不影响代码行为。
