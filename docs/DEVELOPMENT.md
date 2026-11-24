---
title: 开发流程 —— 改哪里、怎么验、什么不许动
type: 规范
tags: [场景空间设计器, 开发流程, 目录结构, 验收, 迁移纪律]
created: 2026-11-24
updated: 2026-11-24
author: demo
status: 现行
project: scene-space-designer
---

# DEVELOPMENT —— 改哪里、怎么验、什么不许动

> 读这份之前先读 [`ARCHITECTURE.md`](ARCHITECTURE.md)（分层与规则真源）与 [`RUNBOOK.md`](RUNBOOK.md)（怎么起、怎么排障）。
> 本文只回答一个工程师上手后最常问的三件事：**这个改动该落在哪个文件**、**改完怎么验**、**哪些东西碰不得**。

---

## 1. 工作区结构

```
spatial-core/            规则内核：纯 JS、零依赖、不 import DOM / 不 import Vue / 不读文件
  src/                   geometry / wall / room / openings / doors / clearance / placement / route /
                         walkbasis / collision / scheme / validate / params / history / model / case-runner
  test/*.test.js         单测（node --test）
  test/cases/rules.json  语言中立用例表：JS 与 Java 两侧都跑它（**对账凭据**）
app/                     前端（Vue 3 + Vite + Three.js）
  src/pages/             页面（设计器 / 方案库 / 维护端 / 参数 / 审计 …）
  src/components/        组件（面板、抽屉、弹层、角标 …）
  src/scene2d.js         2D 平面图；scene3d.js / views3d.js / detail3d.js 负责 3D
  src/catalog.js         目录（优先 `/api/catalog`，失败退回内置演示目录）
  src/data/              内置演示目录与门表（后端没起时的兜底）
  test/                  node --test（通过 test/alias.mjs 把 `@core` 指到 spatial-core/src）
  scripts/               sync-assets.mjs（复制模型到 public/）、gen-doors.mjs（从 GLB 实测量门）
server/                  后端（Spring Boot 4.1.1 + Java 21）
  src/main/java/com/scene/spatial/
    api/ web/ auth/      接口、装配、会话
    kernel/              规则内核的**逐行移植件**（Cases.java 与 rules.json 对账，Params.java 与 PARAM_SPEC 对账）
    scheme/ catalog/     方案与目录（内存档 / JDBC 档两套实现，跑同一套契约测试）
    admin/ audit/ params/ 维护端、审计、参数
  src/main/resources/db/migration/   Flyway（V* 只加不改；R__ 可重复）
  src/test/java/…        后端测试（连真库那部分需要 MySQL）
assets/                  演示模型 + 目录清单 JSON（`catalog/*.json`、`optimized/lod.manifest.json`）
config/params.default.json   由 `tools/export-params.mjs` 从 PARAM_SPEC 生成，**不要手改**
tools/                   模型管线（models/）、参数导出、引号检查、单 jar 打包、设口令
docs/                    公开文档（本目录）
```

## 2. 改动的落点

| 我想改…… | 落在哪里 | 还要同步什么 |
| --- | --- | --- |
| 一条业务判据（净空、占地、开门、自动摆位…） | `spatial-core/src/*.js` | ①`spatial-core/test/` 里的单测；②`test/cases/rules.json` 加/改用例；③`server/.../kernel/Cases.java` 同步移植；④必要时 `Params.java` 与 `PARAM_SPEC` |
| 一个可调参数（阈值、默认值） | `spatial-core/src/params.js` 的 `PARAM_SPEC` | `node tools/export-params.mjs` 重新生成 `config/params.default.json`；`Params.java` 同步 |
| 目录/机型数据（演示） | `server/.../db/migration/R__seed_product_catalog.sql` + `app/src/data/catalog.js` | `assets/catalog/*.json`（前端运行时也读） |
| 界面文案 / 角标 | `app/src/pages/` `app/src/components/` | 角标必须能回答「为什么」（`title` / 原因字段），不许只有颜色 |
| 接口 | `server/.../api/` 或对应域包 | 前端 `app/src/api.js`；契约改动要补后端契约测试 |
| 数据库结构 | **新增** `server/.../db/migration/V<n>__*.sql` | 见 §4；不要改旧文件 |
| 文档 | `docs/`（公开的这几份） | 数字/命令要与代码一致（`gate.sh` 就是判据） |

## 3. 开发循环与验收

```bash
npm --prefix app run dev        # 前端热更（5180）；predev 会先跑 npm run assets
bash start.sh --status          # 看三个端口 / 存储档 / 内核用例表
bash tools/verify/gate.sh       # 五步：core → app → java → quotes → build
```

分层单跑：

```bash
npm --prefix spatial-core test                        # 规则内核（几百条断言，秒级）
npm --prefix app test                                 # 前端（会连带再跑一遍内核）
cd server && mvn -B test                              # 后端（需真 MySQL）
python3 tools/verify/check-quotes.py                  # 引号铁律
```

**SKIP 不是 PASS。** 输出里出现 SKIP（例如「公开仓未发布该演示模型」）说明这条判据这一轮没被量到，
别把它算成通过；补上模型或补上数据让它真的跑起来。

## 4. 迁移纪律（踩过坑，写死）

- 已应用的迁移**不能改一个字节**：改 checksum 就对不上，已有环境直接拒绝启动。出错只能**往前加一版**。
- 新增迁移前先 `ls server/src/main/resources/db/migration/` 看最大版本号，别重号。
- 写数据迁移前先用 `SELECT COUNT(*) WHERE …` 证明键能命中；跑完**回库 `SELECT` 数一遍**，不看日志。
- **`Flyway success=1` ≠ 数据真的被改**：键写错时它照样成功，只是命中 0 行（本项目真发生过：
  拿目录 id 去对 `model_no`）。产品的身份是 `recipe_json.id`，不是自增 `product.id`，也不是 `model_no`。
- 拼 SQL 不许只拼片段：一条语句必须完整以动词（`UPDATE` / `INSERT` / `DELETE`）开头，拼完数句数再空跑一遍。
- `mvn package` 只增不删：删/改名迁移后要 `mvn clean package`，防止 `target/` 里留着两份。
- **门有两个口径，别合并**：`product_model.hinge_nodes` 是**实测**门几何，`recipe_json.doors` 是**声明**门几何。
  目录接口两个都发（`doors` / `recipeDoors`），内核优先实测、无模型时退回声明并标注 `doorsSource`
  （`measured` / `declared` / `none`）。合并之后「供应商模型没按规范校准」就再也查不出来了。
  退回分支不是装饰：只有声明门、没有模型的机型若拿不到声明门，运行时内核会「一扇门都没有」，
  门净空判据整片失败（实测过一次：7 条 `door-clearance-*` 全红）。

## 5. 两条“看起来多余”的规矩

**① 源码字符串里不许出现半角双引号**（中文文案一律用「」）。理由不是风格：本项目历史上半角引号
会让字符串提前结束，报错位置离真正原因很远，一次排查能烧掉半小时。`tools/verify/check-quotes.py` 是闸门。

**② 判据要逐轴比较，不要用平均比值。** 平均会把不齐的轴平均掉（历史事故：深 +13% 被平均判成 1:1）。
同理：**别把「刻意优化」报成缺陷**（假角标比没有角标更坏）、**判据只在自己适用的条件下发声**
（`envelope_ok` 在 `1:1` 模式才叫「尺寸对账」，`fit` 模式下它说的是「能否放进声明包络」，不是同一件事）。

## 6. 提交与协作

- 一个改动一个主题；提交信息写「为什么」而不是「改了哪个文件」。
- 迁移、种子、参数表、用例表这类**跨两份实现**的改动，必须在同一个提交里两边一起改 —— 否则对账就断了。
- 多人/多智能体并行时按**文件所有权**分工：一个文件只有一个写入者；共享文件（`README.md`、设计决策记录）只留一个写入者。
- 不确定就问，不要「先放宽红线再解释」。

## 7. 「设计决策记录」是什么

代码与注释里会出现「设计决策记录」这个引用 —— 它指项目**内部的设计决策留档**（一条决策一段：
背景、取舍、被推翻的旧方案），**不随公开仓发布**，因为里面含现场部署与验收过程。

引用它的目的不是「去点开」，而是提醒后来的人：**这些阈值与判据是踩过坑才定下来的，别顺手改。**
读不到那份留档时按主题去找随附的文档（架构 → `ARCHITECTURE.md`，判据 → `KERNEL.md`，
界面 → `UI-SPEC.md`，运维 → `RUNBOOK.md`），详见 [`DECISIONS.md`](DECISIONS.md)。
