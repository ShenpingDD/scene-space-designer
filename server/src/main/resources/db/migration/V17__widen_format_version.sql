-- V17__widen_format_version.sql —— `format_version` 列宽 32 → 64（W4 人员地面动线，格式标识变长）
--
-- 为什么必须改：W4 把格式标识换成 `scene-space-designer-scene-routes`（**33 字符**），
-- 而 `scheme.format_version` 从 V1 起就是 VARCHAR(32)。建方案时写这一列直接
-- `Data truncation: Data too long for column 'format_version'`（实测：12 条集成测试 500）。
--
-- 为什么不走别的路（都被否了，理由留在这里防重犯）：
--   · 把标识缩短：`scene-space-designer-scene-routes` 是 设计决策记录 §三 T1 的**冻结裁决**，
--     为迁就一个列宽改数据契约本末倒置；
--   · 列里继续写上一代（`scene-space-designer-scene`）：零迁移，但这一列就不再等于当前代号 ——
--     列注释写着「格式标识（哪一代）」，让它说谎比加一版迁移坏；
--   · 改 V1 / V14：已应用的迁移一个字节都不能改（checksum 对不上，已有环境拒绝启动，AGENTS.md §4）。
--
-- 只改类型、不动数据、不动注释语义：旧行（26 字符及更短）原样可读，新行（33 字符）能写进去。
-- 64 给下一代留出余量；MySQL 的 VARCHAR 按字符计长，与中文/ASCII 无关。
--
-- 判据（跑完回库看，不看日志）：
--   SELECT version, description, success FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 2;
--   SHOW COLUMNS FROM scheme LIKE 'format_version';   -- Type 必须是 varchar(64)

ALTER TABLE `scheme`
  MODIFY COLUMN `format_version` VARCHAR(64) NOT NULL
  COMMENT '格式标识（哪一代）：W4 起新写 scene-space-designer-scene-routes；scene-space-designer-scene 及更早标识仍可导入';
