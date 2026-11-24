-- V15：把两条模型判据列改成**可为空** —— 「没判」与「判为否」不是同一件事。
--
-- ## 为什么要改
-- `envelope_ok` / `anisotropy_ok` 建表时都是 `TINYINT(1) NOT NULL DEFAULT 1`。
-- `DEFAULT 1` 的含义是「默认宣称一切正常」：
--
--   ① 维护端新增产品时，只要请求里漏了 `anisotropyOk`，库里就落一个 1（各轴缩放均匀）——
--      而前端**其实算得出来**（`gltf.js` 的 fitClone）。于是设计端体检报 `shapeOk=false`，
--      维护端列表却一个角标都不出（第 2 轮对抗式审查 dev-1）。
--   ② V10 那次的教训是同一个：4 个模型全是列默认值 1，而实测真相是 demo-freezer-dual/demo-freezer-upright/demo-freezer-chest = 0。
--      库里躺着一条假话，是这一整套里最难发现的一种错。
--
-- ## 为什么不是 DEFAULT 0
-- 0 是「判为不正常」，一样是替模型下结论（会平白冤枉一份模型）。**缺读数就该是 NULL**，
-- 读出侧把 NULL 说成「未判 / 未对账」—— 三态才说得清这件事。1:1 模型不做缩放，
-- 「各轴缩放是否均匀」对它本来就不适用，`models.verified.json` 里那一格也是 null。
--
-- ## 已有数据一动不动
-- `MODIFY COLUMN` 不改已有行的值：原来判过 0/1 的照旧（那是当时的真结论）。
-- NULL 只出现在「以后漏传读数」时，以及 1:1 那种「本来不适用」的场合。
-- 种子（`R__seed_product_catalog.sql`）同步带上 `anisotropy_ok`，所以新库也不会再默认说"正常"。
--
-- ## 跑完去库里核对（不看日志）
--   SHOW COLUMNS FROM `product_model` LIKE 'anisotropy_ok';   -- Null 应为 YES，Default 应为 NULL
--   SELECT COUNT(*) FROM `product_model` WHERE `anisotropy_ok` IS NULL;   -- 新库：1（1:1 那份不适用）

ALTER TABLE `product_model`
  MODIFY COLUMN `envelope_ok` TINYINT(1) NULL DEFAULT NULL
    COMMENT '1:1 时=声明与实测逐轴 ≤1mm；fit 时=量纲没弄错；NULL=未判（没读数）',
  MODIFY COLUMN `anisotropy_ok` TINYINT(1) NULL DEFAULT NULL
    COMMENT 'fit 时=各轴缩放均匀（≤ model.anisotropyWarn）；1:1 不适用；NULL=未判';