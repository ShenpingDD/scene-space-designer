-- V19：产品级动作库 + 热点 action_key（docs/111 定稿）
--
-- 只新增一张表 + 一列，**不改 V1–V18、不回填数据**：
--   product_action             1:N，产品可执行的动作（开门、抽屉拉出、灯带开关、动画片段…）
--   product_hotspot.action_key 热点 → 动作的引用（**不建外键**，服务层校验）
--
-- 为什么动作是「产品级」而不是「热点级」：同一个「开门」会被门内托盘、铰链、铭牌等多个热点引用；
-- 动作若挂在热点上，改一次角度要改 N 条热点，发布快照里同一条动作还会出现 N 份。
-- 动作库是产品的**一份**事实，热点只是引用它。
--
-- 为什么 action_key 不建外键：动作库整体替换 = 先删后插；热点引用若带 FK，
-- 删除顺序会把「替换」卡成删除死锁/失败。引用完整性由服务层在同一个事务里校验：
-- 本次请求里出现未知 key → 422；替换动作库时未被重写的旧热点引用 → 清空为 NULL。

CREATE TABLE `product_action` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id`  BIGINT UNSIGNED NOT NULL,
  `action_key`  VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
                COMMENT '产品内唯一；[A-Za-z0-9_-]；热点按它引用',
  `name`        VARCHAR(80)  NOT NULL COMMENT '界面显示名（如「开门」）；中文只是数据，不是接口代码',
  `kind`        VARCHAR(16)  NOT NULL COMMENT 'rotate / translate / visibility / clip（ASCII 代码）',
  `target_json` JSON         NOT NULL COMMENT '作用目标 {path:[节点名...], index:先序第几个}',
  `motion_json` JSON         NOT NULL COMMENT '运动参数 {axis,angleDeg,direction,pivotMm,distanceMm,visible,clipName,durationMs,toggle}',
  `sort_order`  INT          NOT NULL DEFAULT 0 COMMENT '展示顺序（0 基；每次保存按数组顺序重排）',
  `updated_by`  VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '名字快照，不建外键（人可停用，记录要留）',
  `created_at`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_action_product_key` (`product_id`, `action_key`),
  KEY `idx_action_product` (`product_id`),
  CONSTRAINT `fk_action_product` FOREIGN KEY (`product_id`) REFERENCES `product` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='产品级动作库（热点按 action_key 引用；发布快照内嵌一份）';

ALTER TABLE `product_hotspot`
  ADD COLUMN `action_key` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL
    COMMENT '引用的产品动作 key（product_action.action_key）；NULL=不绑动作；不建外键，服务层校验'
    AFTER `camera_json`;
