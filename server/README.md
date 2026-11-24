# server —— 场景空间设计器后端（Spring Boot + MySQL）

一句话：**在线只有一个后端（Java）**（ADR-0003）。这是它的骨架与数据库迁移。
设计依据见 [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)（分层、单租户/内网口径、存储两档）。

## 1. 三步上库

```bash
# ① 建库（只需一次；迁移脚本不建库，建库是运维动作）
mysql -uroot -p < server/db/00-create-database.sql

# ② 配连接（改 application.yml 的 spring.datasource，或用环境变量覆盖）
#    DB_URL / DB_USER / DB_PASSWORD

# ③ 起服务 —— Flyway 启动时自动按 V1 → V2 → V3 执行
mvn spring-boot:run
```

迁移是**加版本、不改旧文件**：以后加字段写 `V4__xxx.sql`，别去改 `V1`（Flyway 会校验历史文件的 checksum）。

## 2. 表清单（7 张）

| 表 | 一句话 | 关键设计 |
| --- | --- | --- |
| `sys_user` | 本地用户（先做一张表，哪怕只有一个用户） | `external_id` 为将来接统一身份预留；`role_code` 避保留字 `ROLE` |
| `scheme` | 方案（一个空间 = 一个方案） | `room_json` 就是前端那份 v4 `state`（**零迁移**）；`rev` 乐观锁；`params_rev` 记当时生效的规则参数版本 |
| `scheme_revision` | 版本历史 | 每次保存存快照，可回滚 |
| `scheme_share` | 分享链接 | 免登录只读 + 有效期（G7） |
| `product` | 产品主数据 | `recipe_json` 与前端 `getProduct()` 形状一致，服务端**不重排** |
| `product_model` | 产品-模型关联（1:N） | 尺寸与门数据**全是实测值**：`bbox_*` / `hinge_nodes` / `envelope_mode`；**不存推算值**（比例因子由前端按 recipe 算，存下来就是第二份真相） |
| `app_config` | 规则参数 | 键名与 `PARAM_SPEC.path` 完全一致；带 `rev` / `updated_by`（改规则参数 = 改业务语义，必须可追溯）；`scope` 字段预留 |

`product_model.hinge_nodes` 存的是**运行时形态**的门数据（`{node, axis, hinge{x,z}, swing, h, openAngleDeg, leaf}`），
即 Java 侧跑规则 7（开门净空）**直接能用的形状**——省掉一步转换，也就省掉一类转换错。

## 3. 种子数据是**派生物**，不是手抄

```bash
node tools/server/gen-seed-sql.mjs   # 重新生成 V2 / V3
```

| 种子 | 来源（唯一真实来源） |
| --- | --- |
| `V2__seed_products.sql` | `assets/catalog/products.json` + `assets/catalog/models.verified.json` + `app/src/data/doors.measured.js` |
| `V3__seed_params.sql` | `config/params.default.json`（← `spatial-core/src/params.js` 的 `PARAM_SPEC`） |

源变了就重跑；脚本里带断言，源和数据对不上会**响亮地失败**（不写出半个文件）。
**不要手改生成的 SQL** —— 下次生成会被覆盖掉。

## 4. 校验到什么程度（诚实边界）

```bash
cd tools/server && npm run verify    # 或 node tools/server/verify-seed.mjs
```

已验：

- 三个 SQL 文件由 `node-sql-parser` 按 **MySQL 方言真解析**通过（不是"看着像"）；
- 7 张表的**列数写死成契约**（改了必须显式改校验器）；
- 6 条外键：本表列存在、目标表/列存在；
- 种子的列名全部存在于表结构；行数 4 / 4 / 34；
- 种子引用的 **10 个 GLB 全在磁盘上**（合计 1.21 MB，与 R5-5 记录一致）；
- 参数种子 **34 项**的键名 / 默认值 / 类型与 `params.default.json` **逐项相等**。

**已验证**：本仓 CI（`.github/workflows/ci.yml`）在 `mysql:8.0` 服务容器上跑 `bash tools/verify/gate.sh`，
即「空库 → Flyway 一路迁到最新版 → 全部后端测试」；本机验证见 `docs/RUNBOOK.md`。
所以：**这是语法级 + 结构级校验，不等于"跑过一遍"。** 上库时按 §1 三步走，Flyway 会在启动时执行并报告。

## 4.5 Java 侧内核与用例表（当前 14/22）

```bash
bash tools/server/run-java-kernel.sh      # 编译 + 跑，一条命令；JDK 路径用 JDK_HOME 覆盖
node tools/server/gen-java-data.mjs       # 重新生成 Cases.java / Params.java（用例表或参数表变了就重跑）
```

`server/src/main/java/com/scene/spatial/kernel/` 是 **spatial-core 的 Java 移植**（逐行对齐，不是重写），
跑 `spatial-core/test/cases/rules.json` 那张**语言中立用例表**。这是"服务端是唯一裁判"的验收基准：
前端与后端同一份判据、同一份期望值，结论不同就是有人把规则改歪了。

**暂不用 JUnit**：内核纯函数、零依赖，`javac + java` 就能真跑 —— 语义正确性不该被构建工具绑架。
Spring 进来后装个 JUnit 壳子调 `CaseRunner` 即可，判据不用抄第二遍。

生成 Java 数据类时踩到的两个坑（**别重复踩**）：

1. **javac 对单个巨型集合字面量会卡死**：35 KB 一个 `Map.ofEntries(...)` → 240 秒不返回（无报错、就是不动）。
   拆成"每条用例一个小方法"后秒级编译。→ 生成 Java 代码时别生成巨型字面量。
2. **`Map.ofEntries` / `List.of` 不接受 null**：用例里的 null 是**有意义的期望值**，
   删掉 null 键会让断言变成空断言（校验器悄悄失效，比失败更糟）。所以生成物里用允许 null 的 `m()/l()`。

## 4.6 Spring Boot 骨架（服务怎么起来）

```bash
mysql -u root -p < db/00-create-database.sql    # 一次性建库（库内演进由 Flyway 负责）
cd server && mvn spring-boot:run                # 默认 8080
curl http://127.0.0.1:8080/api/health           # {"ok":true,...}
curl http://127.0.0.1:8080/api/health/kernel    # {"passed":22,"failed":0,...} ← 内核自检
```

数据源/端口都走环境变量口子（`DB_HOST`/`DB_USER`/`DB_PASSWORD`/`SERVER_PORT`），换环境不改文件。

版本：Spring Boot **4.1.1** —— 3.5.x 的 OSS 支持已于 2026-06-30 结束（最后一版 3.5.16），
4.0.x 到 2026-12-31、4.1.x 到 2027-07-31。新建工程没有迁移负担，直接落在 OSS 窗口最长的那条线上。

## 5. 工具链要求（不写死任何本机路径）

| 项 | 要求 |
| --- | --- |
| JDK | **21**（`JAVA_HOME` 指向它；`java -version` 要是 21.x） |
| Maven | 3.9+（在 `PATH` 里即可；本机需要私有仓库配置就自己放 `~/.m2/settings.xml`） |
| MySQL | 8.0，`127.0.0.1:3306`，库名默认 `spatial_design`（`DB_NAME` 可覆盖） |
| Node | ≥ 20（只用 `npm --prefix app` 那条前端链路，后端不依赖） |

看不到「后端在线」而显示「后端未连接」→ 后端没起，或端口不是 8080（前端可用 `SPATIAL_API=http://127.0.0.1:9090 npm run dev` 指过去）。
