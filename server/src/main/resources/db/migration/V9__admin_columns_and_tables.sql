-- V9：维护端（R6）要用的列与表。**只加不改不删** —— 已发布的 V1~V8 一个字节都不动。
--
-- 逐条依据来自 docs/32-maintenance-console-design.md（数据模型增量那两节）：
--   product.updated_by          卡片要显示"更新人"。现在只有 updated_at，**没人**
--   product.door_verified       门型是否**确认过**（0=未确认 → 规则7 开门净空体检算不准）。注意它不是"有没有门"
--   product.door_source         门型从哪来：user / admin / auto（**枚举用代码，中文只在界面** —— V8 的教训）
--   product.plan_sprite_*       顶视图要落盘（与 thumb 三列同构：file / size / checksum）
--   product_model.anisotropy_ok **路线图A 发现的缺口**：fit 模型的 envelope_ok 说的是"能否放进声明包络"，
--                               **不是**"尺寸对不对"。真正该看的判据是各轴缩放是否均匀 → 补这一列。
--   scheme.cover_*              列表要封面（与 thumb 三列同构）
--   scheme.status               交付流转 draft/submitted/delivered；"已交付"由交付包生成**自动置位**，不靠人勾
--   scheme.tags                 沉淀/经典案例。方案量级几百~几千，json 列足够，**不值得为标签开一张表**
--   scheme.updated_by           owner_id 是"创建的"，"最近谁改的"是另一个问题（多人协作时必须分开）
--   scheme_delivery             交付记录：图纸要拿出去用，结论必须**钉在某一版上**（rev + params_rev + 文件清单）
--   config_revision             参数审计：参数是**会影响已存方案结论**的东西，必须能回答"谁把 90 改成了 85"
--   audit_log                   操作日志：谁在什么时候改了产品/方案/参数
--
-- 索引口径：scheme / config_revision 量级小（几百~几千），**先不加索引，真慢了再说**；
--           audit_log 是只增不删、且按"最近 N 条"和"某对象的历史"查 → **只给它加两个**。

-- ── product：更新人 / 门型确认 / 顶视图 ──────────────────────────────────────
ALTER TABLE `product`
  ADD COLUMN `door_verified`        TINYINT(1)   NOT NULL DEFAULT 0  COMMENT '门型是否**确认过**（0=未确认 → 规则7 开门净空算不准）；不是"有没有门"' AFTER `door_part`,
  ADD COLUMN `door_source`          VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '门型来源代码：user=用户资料 / admin=维护端人工 / auto=几何推导待确认' AFTER `door_verified`,
  ADD COLUMN `plan_sprite_file`     VARCHAR(255) NOT NULL DEFAULT '' COMMENT '顶视图相对路径（维护端拾取产物；未生成为空）' AFTER `door_source`,
  ADD COLUMN `plan_sprite_size`     INT UNSIGNED NOT NULL DEFAULT 0  COMMENT '顶视图字节数' AFTER `plan_sprite_file`,
  ADD COLUMN `plan_sprite_checksum` CHAR(32)     NOT NULL DEFAULT '' COMMENT '顶视图 md5（与 checksum 同款验收口径）' AFTER `plan_sprite_size`,
  ADD COLUMN `updated_by`           VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '最近一次修改人（存名字快照，不建外键：人可停用、记录要留）' AFTER `updated_at`;

-- ── product_model：各轴缩放是否均匀 ──────────────────────────────────────────
-- 与 envelope_ok **同款类型**（TINYINT(1) NOT NULL DEFAULT 1），两个判据挨着放。
ALTER TABLE `product_model`
  ADD COLUMN `anisotropy_ok` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '各轴缩放是否均匀（envelope_mode=fit 时真正该看的判据）' AFTER `envelope_ok`;

-- ── scheme：封面 / 状态 / 标签 / 更新人 ──────────────────────────────────────
ALTER TABLE `scheme`
  ADD COLUMN `cover_file`     VARCHAR(255) NOT NULL DEFAULT '' COMMENT '封面相对路径（保存时截三维视角；文件在 assets/covers/）' AFTER `room_json`,
  ADD COLUMN `cover_size`     INT UNSIGNED NOT NULL DEFAULT 0  COMMENT '封面字节数' AFTER `cover_file`,
  ADD COLUMN `cover_checksum` CHAR(32)     NOT NULL DEFAULT '' COMMENT '封面 md5（改了封面必须变 → 前端缓存键）' AFTER `cover_size`,
  ADD COLUMN `status`         VARCHAR(16)  NOT NULL DEFAULT 'draft' COMMENT '交付流转代码：draft / submitted / delivered' AFTER `params_rev`,
  ADD COLUMN `tags`           JSON         NULL COMMENT '标签数组 ["标杆案例","冷链",...]；NULL=无标签（不是空数组）' AFTER `status`,
  ADD COLUMN `updated_by`     VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '最近一次修改人（owner_id 是"创建的"，这是"最近谁改的"）' AFTER `updated_at`;

-- ── 新表：交付记录 ──────────────────────────────────────────────────────────
CREATE TABLE `scheme_delivery` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `scheme_id`   BIGINT UNSIGNED NOT NULL,
  `rev`         INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT '交付时打的方案版本（scheme.rev）—— 图纸必须钉在某一版上',
  `params_rev`  INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT '当时的规则参数版本：体检结论是在**某一版参数**下得出的',
  `catalog_rev` INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT '生成时的目录 rev（数据血缘，出问题能追溯）',
  `files_json`  JSON            NULL COMMENT '文件清单 [{name,bytes,checksum}]，够对账即可',
  `with_assets` TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '是否带可选附件（场景+产品 GLB；体积大，默认不带 —— 决策⑧）',
  `packaged_by` VARCHAR(32)     NOT NULL DEFAULT '' COMMENT '生成人（存名字快照）',
  `packaged_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `note`        VARCHAR(255)    NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  KEY `idx_delivery_scheme` (`scheme_id`, `packaged_at`),
  CONSTRAINT `fk_delivery_scheme` FOREIGN KEY (`scheme_id`) REFERENCES `scheme` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='交付包生成记录（"已交付"是可信状态，不是人工勾的）';

-- ── 新表：参数变更审计 ──────────────────────────────────────────────────────
CREATE TABLE `config_revision` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `config_key`    VARCHAR(64)     NOT NULL DEFAULT '' COMMENT '改的是哪一项（app_config.config_key）',
  `scope`         VARCHAR(32)     NOT NULL DEFAULT 'global' COMMENT '作用域（与 app_config.scope 同款）',
  `scope_id`      VARCHAR(64)     NOT NULL DEFAULT '',
  `rev`           INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT '改完之后的参数版本号',
  `old_json`      JSON            NULL COMMENT '改之前的值',
  `new_json`      JSON            NULL COMMENT '改之后的值',
  `snapshot_json` JSON            NULL COMMENT '发布新版本时的**全量快照** —— 已存方案要靠它复现当时的结论（docs/32 §4.4）',
  `changed_by`    VARCHAR(32)     NOT NULL DEFAULT '',
  `changed_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `note`          VARCHAR(255)    NOT NULL DEFAULT '',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='参数变更审计（app_config.rev 只记最后一次 ✗ —— 这里逐条留痕）';

-- ── 新表：操作日志 ──────────────────────────────────────────────────────────
CREATE TABLE `audit_log` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `actor`       VARCHAR(32)     NOT NULL DEFAULT '' COMMENT '谁（存名字快照，不建外键）',
  `action`      VARCHAR(32)     NOT NULL DEFAULT '' COMMENT '动作代码：create / update / disable / upload / publish / deliver',
  `target_type` VARCHAR(32)     NOT NULL DEFAULT '' COMMENT '对象类型：product / product_model / scheme / config',
  `target_id`   VARCHAR(64)     NOT NULL DEFAULT '' COMMENT '对象标识（产品用 model_no、方案用 id —— 用字符串，不同表 id 不互斥）',
  `detail_json` JSON            NULL COMMENT '细节。注意："改了什么"由各表自己的 revision 表回答，这里只记主体/动作/对象',
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_audit_recent` (`created_at`),
  KEY `idx_audit_target` (`target_type`, `target_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='操作日志（只增不删）';
