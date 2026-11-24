-- V5__product_catalog_normalize.sql —— 产品目录规范化（把"该是列的东西"变成列）
--
-- 为什么现在做：产品的介绍 / 来源 / 尺寸可信度 / 色标 / 来源链接，原来**全塞在 product.recipe_json
-- 这一个 JSON 里** —— 能查到，但不是列：没法建索引、没法加约束、维护端也没法逐条编辑。
-- 事实来源仍是 assets/catalog/products.json（派生物）——这里只做规范化，不搬第二份真相。
--
-- 口径（沿用 设计决策记录，不变）：
--   * 尺寸一律存**实测值**（product_model.bbox_*），运行时不再估算
--   * **原始 GLB 不入库，只登记路径**（source_file_path）——入库的是压缩产物（file_path）
--   * 缩略图是**产物**，挂在 product_model 上（一型号多模型时，每套模型一张）

ALTER TABLE `product`
  ADD COLUMN `description` VARCHAR(1024) NOT NULL DEFAULT '' COMMENT '产品介绍（原 recipe_json.desc）' AFTER `series`,
  ADD COLUMN `origin`      VARCHAR(64)   NOT NULL DEFAULT '' COMMENT '资料来源（用户原始模型 / 官网外观重建 / 官网系列外形）' AFTER `description`,
  ADD COLUMN `size_note`   VARCHAR(128)  NOT NULL DEFAULT '' COMMENT '尺寸可信度 —— 业务上最要紧，必须能单独查/单独筛' AFTER `origin`,
  ADD COLUMN `color`       CHAR(7)       NOT NULL DEFAULT '' COMMENT '色标 #rrggbb（左栏卡片用）' AFTER `size_note`,
  ADD COLUMN `source_url`  VARCHAR(512)  NOT NULL DEFAULT '' COMMENT '来源链接（无则空串）' AFTER `color`;

ALTER TABLE `product_model`
  ADD COLUMN `source_file_path` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '原始 GLB 相对路径（只登记不入库，用于追溯）' AFTER `variant`,
  ADD COLUMN `thumb_file`       VARCHAR(255) NOT NULL DEFAULT '' COMMENT '缩略图相对路径（UX-3 产物；未生成为空）' AFTER `source_file_path`,
  ADD COLUMN `thumb_size`       INT UNSIGNED NOT NULL DEFAULT 0  COMMENT '缩略图字节数' AFTER `thumb_file`,
  ADD COLUMN `thumb_checksum`   CHAR(32)     NOT NULL DEFAULT '' COMMENT '缩略图 md5（验收口径，与 checksum 同款）' AFTER `thumb_size`;

-- 说明条目：facts / features 原来是 recipe_json 里的二维数组，没有任何结构。
-- 规范化成行之后，维护端可以逐条增删改、可以排序，也可以按条目名检索（"哪些型号提到 XX"）。
CREATE TABLE `product_note` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `kind`       VARCHAR(16)     NOT NULL COMMENT 'fact=参数/事实，feature=特性（原 facts / features）',
  `label`      VARCHAR(128)    NOT NULL COMMENT '条目名',
  `value`      VARCHAR(512)    NOT NULL COMMENT '条目值',
  `sort_order` INT             NOT NULL DEFAULT 0 COMMENT '同 kind 内的展示顺序',
  `created_at` DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_note` (`product_id`, `kind`, `label`),
  KEY `idx_note_kind` (`kind`),
  CONSTRAINT `fk_note_product` FOREIGN KEY (`product_id`) REFERENCES `product` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='产品说明条目（facts/features 规范化）';