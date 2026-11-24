# RUNBOOK —— 起停、排障、打包

> 目标读者：第一次在本机把这个项目跑起来的人，以及「跑不起来时」要判断问题在哪一层的人。
> 本文件只写**可执行的动作与判据**，不写设计动机（那在 [`ARCHITECTURE.md`](ARCHITECTURE.md)）。

---

## 1. 工具链

| 项 | 要求 | 说明 |
| --- | --- | --- |
| JDK | **21** | `java -version` 必须是 21.x；`JAVA_HOME` 指向它 |
| Maven | 3.9+ | 在 `PATH` 里即可（`MAVEN_BIN` 可覆盖）；需要私有仓库配置就自己放 `~/.m2/settings.xml` |
| MySQL | **8.0** | `127.0.0.1:3306`，库名默认 `spatial_design`（`DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` 可覆盖） |
| Node | **≥ 20** | 引擎 `>=20`；CI 用 22 |
| Python | 3.x | 只有 `tools/verify/check-quotes.py` 与模型管线用 |

脚本一律支持用环境变量覆盖（`JDK_HOME` / `MAVEN_BIN` / `MAVEN_SETTINGS` / `MYSQL_HOME` / `MYSQL_DATA`），
**仓库里不写死任何本机绝对路径**。

## 2. 起停

### 2.1 首次

```bash
mysql -u root -h 127.0.0.1 < server/db/00-create-database.sql   # 建库（只跑一次）
bash start.sh                                                    # MySQL → 后端 8080 → 前端 5180
bash tools/server/set-password.sh admin                          # 演示账号没有默认口令，现场设
```

浏览器 <http://127.0.0.1:5180> 。**「起起来了」的判据不是进程还在**，而是 `start.sh` 结尾那三行求证：

1. 8080 `/api/health` 应答；
2. 8080 `/api/health/kernel` 的 `failed == 0`（内核用例表真的跑了）；
3. 后端日志里写着存储档位是 `MySQL`（不是 memory）。

### 2.2 常用命令

| 命令 | 做什么 |
| --- | --- |
| `bash start.sh` | 默认档：真库 + 前端开发服务器（5180，改代码即时生效） |
| `bash start.sh --prod` | 前端跑生产构建（4180）——机器吃紧时省内存与句柄 |
| `bash start.sh --no-db` | 后端走内存档（见 §2.3 的能力边界） |
| `bash start.sh --status` | 只看现状（端口 / 健康 / 存储档 / 内核用例），不动任何东西 |
| `bash start-prod.sh` | 从开发服务器切到生产构建（停 5180 → 构建 → 起 4180） |
| `bash stop.sh` | 三个一起停（前端 5180/4180 → 后端 8080 → MySQL 3306） |

`stop.sh` **只按端口杀、不按进程名杀**（防止误伤同机的其它 java/node）。

### 2.3 `--no-db` 档的能力边界（重要）

内存档下需要 JDBC 仓储的接口**故意不存在（404）**：`/api/catalog`（型号目录）、`/api/admin/**`（维护端）、
`/api/catalog/reload`。存在的只有 `/api/health`、`/api/health/kernel`、`/api/params`、`/api/schemes`。

所以那一档下：设计端能打开，但**装不进型号**；数据**重启就没**。它的用途是「机器上没 MySQL 时验证服务能起、
内核自检还绿」，**不是日常开发环境**。`start.sh` 会验证「`--no-db` 真的生效了」—— 环境变量名与
`server/serve.sh` 不一致时它会明确 warn，而不是安静地跑成真库档。

## 3. 排障

| 现象 | 先看哪里 | 常见原因 |
| --- | --- | --- |
| `start.sh` 卡住不停 | 后端 8080 是否应答（`curl -s localhost:8080/api/health`） | 后端起不来时启动脚本会一直等健康检查。**起服务一律 `timeout 240 bash start.sh`**，再单独 `bash start.sh --status` |
| 登录成功、下一个请求仍说未登录 | `SPATIAL_SESSION_SECURE` | 内网明文 HTTP 下设成 `true` 时浏览器不回发 cookie（安静失效）；保持默认 `false` |
| 前端起来但目录为空 | 8080 `GET /api/catalog` 的返回 | 后端没起 / 数据库没连上 → 前端会退回内置的演示目录（`app/src/data/catalog.js`），看起来像「有数据但不对」 |
| `Flyway validate` 报 checksum mismatch | `flyway_schema_history` 与 `db/migration/` 是否一致 | 已发布的迁移被改过。**只能往前加版本**，不能改旧文件；本地脏库可以直接重建 |
| `mvn test` 报连不上库 | `mysqladmin -uroot -h127.0.0.1 ping` | 后端测试用真库（迁移要真跑）；库没起时这一步是**环境不满足**，不是通过 |
| `npm --prefix app test` 里有 SKIP | 输出里那条 `公开仓未发布该演示模型` | 正常：几何用例需要 `assets/optimized/<slug>.lod0.glb`，公开仓只有 `demo-blender` |
| 端口被占 | `lsof -nP -iTCP:5180 -sTCP:LISTEN` | 上一轮没停干净；`bash stop.sh` 后重试 |
| macOS 上 Vite 报 `EBUSY` / 整条退出 | `app/vite.config.js` 的 `watch.usePolling` | 别把文件监视改回原生 `fs.watch`：本机别的进程会短暂持有刚写过的文件 |

## 4. 验收

```bash
bash tools/verify/gate.sh                 # 五步全跑
bash tools/verify/gate.sh --list          # 只列步骤
bash tools/verify/gate.sh --only core,app # 只跑指定步骤
bash tools/verify/gate.sh --keep-going    # 失败也跑完，最后汇总
```

| 步骤 | 命令 | 需要 |
| --- | --- | --- |
| `core` | `npm --prefix spatial-core test` | node |
| `app` | `npm --prefix app test` | node |
| `java` | `cd server && mvn -B test` | JDK 21 + Maven + **真 MySQL** |
| `quotes` | `python3 tools/verify/check-quotes.py` | python3 |
| `build` | `npm --prefix app run build` | node |

退出码 `0` 全绿 / `1` 有失败 / **`2` 环境不满足（不是通过）**。每步日志在 `logs/gate/<id>.log`（已 gitignore）。

另有一条**不在这五步里**的检查，因为它扫的是提交历史而不是代码：

```bash
bash tools/verify/check-secrets.sh          # gitleaks 扫全部提交（没有就下官方二进制）
bash tools/verify/check-secrets.sh --staged # 只扫暂存区（pre-commit 用）
```

`2` 表示「本机没装 gitleaks、也下不下来」——没验 ≠ 通过。CI 里它是独立作业 `secrets`，必须真绿。

## 5. 打包

```bash
bash tools/build-single-jar.sh   # 前端构建 → mvn -Psingle-jar clean package → 校验 jar 内有 static/index.html
java -jar server/target/spatial-design-server-0.1.0-SNAPSHOT.jar --server.port=8080
```

- 默认 `mvn package` **不带前端**，别把它当单 jar 包。
- 若上一轮的 JVM 还在跑并锁着 jar，`repackage` 会写不进去（产物「没有主清单属性」）→ 先 `bash stop.sh`。
- 改名/删迁移之后要 `mvn clean package`，否则 `target/` 里可能留着旧版本号。

## 6. 模型与素材

公开仓只带一个演示模型。管线脚本在 `tools/models/`（`optimize-models` 压缩与 LOD、`verify-models.py` 几何验收），
原始模型与缩略图**不在仓库里**；目录 JSON（`assets/catalog/*.json`）随仓库维护，不由脚本生成。前端构建的 `prebuild` 会跑
`app/scripts/sync-assets.mjs`（把 `assets/` 复制进 `app/public/assets/`）与 `app/scripts/gen-doors.mjs`
（从 GLB 实测开门几何，写 `app/src/data/doors.measured.js`）——两者都以仓库里实际存在的文件为准，
缺模型时**跳过并打印 fallback**，不会凭空生成数据。

## 7. 数据与迁移

- 建库用 `server/db/00-create-database.sql`；库内演进全部由 Flyway（`server/src/main/resources/db/migration/`）负责。
- **已应用的迁移不能改一个字节**（checksum 对不上，已有环境会拒绝启动）：出错只能往前加一版。
- 种子数据是**可重复迁移**（`R__seed_product_catalog.sql`），改演示目录改它，不要改 `V*` 历史文件。
- 公开仓的种子与私有部署不同，checksum 必然不同 → **公开版请从空库开始**。
