# 参与贡献

## 先读

- `README.md`：30 秒启动、一条命令验收、目录结构
- `docs/DEVELOPMENT.md`：改动落在哪个文件、迁移纪律、两条硬规矩（半角引号、逐轴比较）
- `docs/ARCHITECTURE.md`：三层结构与 `spatial-core/` 是唯一规则真源这件事

## 提交前必须过的一条命令

```bash
bash tools/verify/gate.sh
```

它跑内核单测、前端单测、后端测试（需要真 MySQL）、引号铁律、前端构建五步。
退出码 `0` 才算通过；`2` 表示环境不满足（缺库/缺工具），**不是通过**。

只想跑某一层：

```bash
npm --prefix spatial-core test
npm --prefix app test
cd server && mvn -B test
python3 tools/verify/check-quotes.py
npm --prefix app run build
```

## 改动纪律

- **业务规则只有一份真源**：`spatial-core/`。Java 侧是逐行移植件，改一处必须两边一起改，
  并用同一份用例表（`spatial-core/test/cases/rules.json`）对账。
- 用例表改了就同步 `server/src/main/java/com/scene/spatial/kernel/Cases.java` 头部记的
  `sha256(前16)`（`GeneratedDataFreshnessTest` 会用真实哈希比对），否则后端测试立刻红。
- 已发布的 Flyway 迁移（`server/src/main/resources/db/migration/V*.sql`）**不能改**，
  改了 checksum 就对不上；要改数据只能往前加一版。
- 字符串里不使用半角双引号，用「」；`check-quotes.py` 会拦。
- 判据要「逐轴」比较，不用平均比值；不报静默的筛选，不造假角标。

## 提交信息

一句话说清「改了什么、为什么」，比「fix bug」有用。涉及判据改动的，把判定条件写进正文。

## 贡献的授权（CLA）

本仓是**双许可**项目（AGPL-3.0-only + 商业授权），所以外部贡献需要签 `CLA.md`：
它授予项目方「可以按另一种许可再发布」的权利 —— 光说「按 AGPL 发布我的贡献」不够用，
那不能把同一份代码放进商业版。

- 第一次提 PR 时 CLA 助手会自动留言，点一次同意即可（按 GitHub 账号留痕）；
- 你的版权仍然是你的，CLA 不是版权转让；
- 贡献物必须是你原创，或你有权授予上述许可；职务成果请先取得雇主书面同意。

细节见 [`CLA.md`](CLA.md)。

## 安全问题

不要开公开 Issue，见 `SECURITY.md`。
