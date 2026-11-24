-- V14__state_generation_comment.sql —— 把"房间 JSON 是什么格式"的**注释**改到对得上（W1 门洞）
--
-- 为什么只改注释、不改数据：`scheme.room_json` 是 **JSON 列**，它存的就是前端那份 `state`。
-- W1 把墙从扁平数组 `[x1,z1,x2,z2]` 升成对象 `{a,b,openings}`（格式标识同时换代，
-- 见 `Scheme.FORMAT` / `spatial-core/src/scheme.js`），但**列的类型没有变** ——
-- 库里已有的行仍然能读（导入端宽容、写入端唯一），所以没有数据迁移。
--
-- 改注释的原因是**界面/运维必须说真话**：`v4 格式的 state` 这句话从 R6-3 起就不准了
-- （当时的标识已经是 `scene-space-designer`），到 W1 更不准。留着它，下一个人会照它写代码。
--
-- ⚠️ 为什么不直接改 `V1__init.sql`：**已应用的 Flyway 迁移一个字节都不能改**
-- （checksum 对不上，已有环境直接拒绝启动 —— AGENTS.md §4 / §7）。所以只能往前加一版。
--
-- 判据（跑完回库看，不看日志）：
--   SELECT column_comment FROM information_schema.columns
--    WHERE table_schema='spatial_design' AND table_name='scheme' AND column_name='room_json';

ALTER TABLE `scheme`
  MODIFY COLUMN `room_json` JSON NOT NULL
  COMMENT '前端那份 state（{w,d,h,walls,items}）；W1 起墙是对象 {a,b,openings}，标识 scene-space-designer-openings';

ALTER TABLE `scheme`
  MODIFY COLUMN `format_version` VARCHAR(32) NOT NULL
  COMMENT '格式标识（哪一代）：新写一律 scene-space-designer-openings；scene-space-designer 与 demo-*-v* 仍可导入';