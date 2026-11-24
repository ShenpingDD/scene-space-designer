-- V18：产品详情内容 + 3D 热点（设计决策记录定稿）
--
-- 只新增两张表，**不改 V1–V17、不回填数据**：
--   product_content  1:1，编辑态 draft_json + 已发布快照 published_json + rev/published_rev
--   product_hotspot  1:N，热点的编辑态行（保存时序列化进 product_content.published_json）
--
-- 为什么热点必须是表而不是 JSON 数组：热点要有稳定 id、逐条校验、排序与将来的媒体列；
-- 整块 JSON 覆盖会让「改一条热点」变成「重发整块」，并发编辑无法收口（设计决策记录 §五.3）。
-- 简介**不建列**：复用 product.description（既有 VARCHAR(1024)），快照里只存副本。

CREATE TABLE `product_content` (
  `product_id`     BIGINT UNSIGNED NOT NULL,
  `draft_json`     JSON            NOT NULL COMMENT '编辑态内容 {sellingPoints[],params[]}；不含简介（简介=product.description）',
  `published_json` JSON            NULL     COMMENT '已发布快照 {content,hotspots[],model,validation,publishedRev,publishedAt}；NULL=从未发布过',
  `rev`            INT             NOT NULL DEFAULT 0 COMMENT '编辑态版本：每次编辑态保存成功 +1；写接口用 expectedRev 做乐观锁',
  `published_rev`  INT             NOT NULL DEFAULT 0 COMMENT '已发布对应的 rev；正常保存即等于 rev；发布步骤失败时可小于 rev；0=从未发布',
  `published_at`   DATETIME(3)     NULL,
  `updated_by`     VARCHAR(32)     NOT NULL DEFAULT '' COMMENT '名字快照，不建外键（人可停用，记录要留）',
  `created_at`     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`product_id`),
  KEY `idx_content_published` (`published_rev`),
  CONSTRAINT `fk_content_product` FOREIGN KEY (`product_id`) REFERENCES `product` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='产品详情内容（编辑态 + 已发布快照；1 产品 1 行）';

CREATE TABLE `product_hotspot` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id`    BIGINT UNSIGNED NOT NULL,
  `model_id`      BIGINT UNSIGNED NOT NULL COMMENT '绑定到具体 product_model 行（变体级）；v1 只允许 default',
  `seq`           INT             NOT NULL DEFAULT 0 COMMENT '同一产品内展示顺序（0 基，服务端重排后连续）',
  `title`         VARCHAR(40)     NOT NULL DEFAULT '',
  `body`          TEXT            NOT NULL COMMENT '纯文本，≤300 字符；不存 HTML/Markdown',
  `media_file`    VARCHAR(255)    NOT NULL DEFAULT '' COMMENT 'v1 不启用（图片/媒体后续再做）；保留列，默认空',
  `media_alt`     VARCHAR(200)    NOT NULL DEFAULT '' COMMENT 'v1 不启用；将来有图时必填（a11y）',
  `node_path`     JSON            NOT NULL COMMENT '根→锚点节点的名字链（含根节点名）；[]=模型根',
  `node_index`    INT             NOT NULL DEFAULT 0 COMMENT '同一 node_path 按先序遍历的第几个（0 基）；解决重名节点',
  `node_name`     VARCHAR(128)    NOT NULL DEFAULT '' COMMENT '仅展示/兜底提示，不参与解析',
  `pos_x`         DECIMAL(12,4)   NOT NULL COMMENT '米；锚点节点局部坐标 × 节点世界等比缩放',
  `pos_y`         DECIMAL(12,4)   NOT NULL,
  `pos_z`         DECIMAL(12,4)   NOT NULL,
  `nrm_x`         DECIMAL(8,5)    NULL COMMENT '节点局部方向，归一化，不乘缩放；用于图标朝向/离面检测/重新吸附',
  `nrm_y`         DECIMAL(8,5)    NULL,
  `nrm_z`         DECIMAL(8,5)    NULL,
  `door_state`    VARCHAR(8)      NOT NULL DEFAULT 'any' COMMENT 'any/open/closed：仅在该动画状态可见；any=都可见；锚点不限门节点',
  `camera_json`   JSON            NULL COMMENT '归一化视角 {azimuthDeg,elevationDeg,distFactor,target[0..1],fov?}',
  `updated_by`    VARCHAR(32)     NOT NULL DEFAULT '',
  `created_at`    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_hotspot_product_seq` (`product_id`, `seq`),
  CONSTRAINT `fk_hotspot_product` FOREIGN KEY (`product_id`) REFERENCES `product` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_hotspot_model`   FOREIGN KEY (`model_id`)   REFERENCES `product_model` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='产品 3D 热点（编辑态；保存时序列化进 product_content.published_json）';
