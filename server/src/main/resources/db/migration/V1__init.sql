-- V1__init.sql —— 场景空间设计器 · 初始表结构
--
-- 依据：docs/06-architecture-baseline.md §4（G1~G4 已定，用户 2026-09-21 确认）
-- 口径：**单租户 / 内网私有化 / 一个空间 = 一个方案（单房间）** → 全库不设 tenant_id
-- 目标：MySQL 8.0 / utf8mb4 / InnoDB
--
-- 几处刻意为之（都是踩过或想过才这么写的）：
--   * role_code / config_key：`ROLE` 与 `KEY` 在 MySQL 8 是保留字，别拿命去试
--   * scope_id 用空串不用 NULL：NULL 在唯一索引里**不去重**，同一把键能插无数行
--   * 尺寸一律存**实测值**（product_model.bbox_*/hinge_nodes）：运行时不再估算尺寸 = FIX-09 的根治
--   * 方案保存的是**前端那份 v4 state**（room_json），服务端不重排领域模型 → 零迁移
--   * 参数表（app_config）改的是**业务语义**（如开门阈值），所以带 rev + updated_by：谁在什么时候把规则改了要查得到

-- ── 用户 ──────────────────────────────────────────────────────────────
CREATE TABLE `sys_user` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username`      VARCHAR(64)     NOT NULL COMMENT '登录名（本地账号）',
  `password_hash` VARCHAR(100)    NOT NULL COMMENT 'BCrypt 60 字符；留到 100 是为了将来换算法不用改表',
  `display_name`  VARCHAR(64)     NOT NULL DEFAULT '',
  `role_code`     VARCHAR(32)     NOT NULL DEFAULT 'designer' COMMENT 'admin/designer/viewer（保留字 ROLE 故加后缀）',
  `enabled`       TINYINT(1)      NOT NULL DEFAULT 1,
  `external_id`   VARCHAR(64)     NULL COMMENT 'G1：将来接统一身份预留；自建账号阶段为 NULL',
  `created_at`    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_username` (`username`),
  KEY `idx_user_external` (`external_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='本地用户表（G1：认证层做成可替换）';

-- ── 方案 ──────────────────────────────────────────────────────────────
CREATE TABLE `scheme` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`           VARCHAR(128)    NOT NULL,
  `owner_id`       BIGINT UNSIGNED NOT NULL,
  `room_json`      JSON            NOT NULL COMMENT 'v4 格式的 state（{w,d,h,walls,items}）—— 就是前端那一份',
  `format_version` VARCHAR(32)     NOT NULL COMMENT '如 legacy-spatial-doors-v4；服务端按它选校验器',
  `params_rev`     INT             NOT NULL DEFAULT 0 COMMENT '保存时生效的参数表版本（规则参数改了要回溯，见 docs/15）',
  `rev`            INT             NOT NULL DEFAULT 0 COMMENT '乐观锁：PUT 必须带 rev，不一致回 409',
  `deleted`        TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删（v1 不做回收站界面）',
  `created_at`     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_scheme_owner` (`owner_id`, `deleted`, `updated_at`),
  CONSTRAINT `fk_scheme_owner` FOREIGN KEY (`owner_id`) REFERENCES `sys_user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='方案（一个空间=一个方案，单房间）';

CREATE TABLE `scheme_revision` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `scheme_id`  BIGINT UNSIGNED NOT NULL,
  `rev`        INT             NOT NULL COMMENT '版本号，与 scheme.rev 同一序列',
  `room_json`  JSON            NOT NULL COMMENT '该版本的完整快照（回滚用）',
  `params_rev` INT             NOT NULL DEFAULT 0,
  `note`       VARCHAR(255)    NOT NULL DEFAULT '' COMMENT '版本说明（用户可填）',
  `created_by` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_rev` (`scheme_id`, `rev`),
  KEY `idx_rev_time` (`scheme_id`, `created_at`),
  CONSTRAINT `fk_rev_scheme` FOREIGN KEY (`scheme_id`) REFERENCES `scheme` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='G5 方案版本历史（每次保存存快照）';

CREATE TABLE `scheme_share` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `scheme_id`  BIGINT UNSIGNED NOT NULL,
  `token`      CHAR(32)        NOT NULL COMMENT '免登录只读的分享口令',
  `expires_at` DATETIME(3)     NULL COMMENT 'NULL = 不过期',
  `revoked`    TINYINT(1)      NOT NULL DEFAULT 0,
  `created_by` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_share_token` (`token`),
  KEY `idx_share_scheme` (`scheme_id`),
  CONSTRAINT `fk_share_scheme` FOREIGN KEY (`scheme_id`) REFERENCES `scheme` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_share_user`   FOREIGN KEY (`created_by`) REFERENCES `sys_user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='G7 分享链接（只读 + 有效期）';

-- ── 产品与模型（G3/G8）────────────────────────────────────────────────
CREATE TABLE `product` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `model_no`    VARCHAR(64)     NOT NULL COMMENT '型号；与产品主数据对齐的锚点',
  `name`        VARCHAR(128)    NOT NULL DEFAULT '',
  `series`      VARCHAR(64)     NOT NULL DEFAULT '',
  `status`      VARCHAR(16)     NOT NULL DEFAULT 'active' COMMENT 'active/disabled',
  `recipe_json` JSON            NOT NULL COMMENT '配方 {w,d,h,...}——与前端 getProduct() 形状一致，服务端不重排',
  `sort_order`  INT             NOT NULL DEFAULT 0 COMMENT '左栏展示顺序',
  `created_at`  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_product_model_no` (`model_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='产品主数据（型号 + 配方）';

CREATE TABLE `product_model` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id`    BIGINT UNSIGNED NOT NULL,
  `variant`       VARCHAR(64)     NOT NULL DEFAULT 'default' COMMENT '颜色/版本/LOD 组；G3：一型号多模型（1:N）',
  `file_path`     VARCHAR(255)    NOT NULL COMMENT '静态 GLB 相对路径（产物入库、原文件不入库）',
  `file_size`     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `checksum`      CHAR(32)        NOT NULL DEFAULT '' COMMENT '源 GLB 的 md5（验收口径）',
  `unit`          VARCHAR(8)      NOT NULL DEFAULT 'mm' COMMENT 'bbox 单位',
  `bbox_w`        DECIMAL(10,3)   NOT NULL COMMENT '实测包围盒（mm）—— 运行时不再估算尺寸',
  `bbox_d`        DECIMAL(10,3)   NOT NULL,
  `bbox_h`        DECIMAL(10,3)   NOT NULL,
  `envelope_mode` VARCHAR(8)      NOT NULL DEFAULT 'fit' COMMENT '1:1 按实测 / fit 按配方等比（R5-5，来自实测字段 envelopeMode）',
  `envelope_ok`   TINYINT(1)      NOT NULL DEFAULT 1 COMMENT '模型是否落在设计包络内（R5-5 验收结论）',
  `delta_vs_source_json` JSON     NULL COMMENT '压缩产物 vs 源模型的最大偏差与容差（验收口径，实测）',
  `hinge_nodes`   JSON            NOT NULL COMMENT '门/铰链实测 [{node,axis,hinge{x,z},swing,h,openAngleDeg}]（R3-7）',
  `lod_json`      JSON            NOT NULL COMMENT 'LOD 清单 {manifest,levels[]}；floorReached（是否触物理下限）在 manifest 里，不另开列',
  `source`        VARCHAR(16)     NOT NULL DEFAULT 'glb' COMMENT 'glb=标准 GLB / param=参数化生成',
  `created_at`    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_model_variant` (`product_id`, `variant`),
  CONSTRAINT `fk_model_product` FOREIGN KEY (`product_id`) REFERENCES `product` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='产品-模型关联表（用户明确要求；尺寸与门数据都在这里）';

-- ── 规则参数（R4-0.5：默认规则变成可配的数据）──────────────────────────
CREATE TABLE `app_config` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `scope`      VARCHAR(16)     NOT NULL DEFAULT 'global' COMMENT 'global/project/customer —— v1 只用 global，字段预留',
  `scope_id`   VARCHAR(64)     NOT NULL DEFAULT '' COMMENT '非 global 时的归属 id。**用空串不用 NULL**（NULL 在唯一索引里不去重）',
  `config_key` VARCHAR(64)     NOT NULL COMMENT '与 PARAM_SPEC.path 完全一致，如 door.openOkDeg（保留字 KEY 故加前缀）',
  `value_json` JSON            NOT NULL COMMENT '值存 JSON（数字/布尔/字符串都能装）；读回时按 PARAM_SPEC 校验范围',
  `value_type` VARCHAR(16)     NOT NULL DEFAULT 'number' COMMENT 'number/boolean/string',
  `rev`        INT             NOT NULL DEFAULT 0,
  `updated_by` BIGINT UNSIGNED NULL,
  `updated_at` DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_config` (`scope`, `scope_id`, `config_key`),
  CONSTRAINT `fk_config_user` FOREIGN KEY (`updated_by`) REFERENCES `sys_user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='规则参数表（参数改的是业务语义，必须可追溯）';
