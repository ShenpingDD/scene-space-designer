-- V6：产品目录补一列 `door_part`（门部件名）
--
-- 为什么它**不能派生**（V5 之后的实测结论）：我原以为"门部件名"能从门的几何推出来
-- （绕 x 轴=上盖 / 两扇以上=双门 / 否则柜门），拿 4 款一对，3 款对上 ——
-- 唯独 demo-freezer-dual（双温双控低温保存箱）错：它的**实测门数据里只有 1 扇**（upper_door，
-- 下门没有进实测），但产品本身是"双门"。
--
-- 于是「门部件名」不是几何的函数，而是**产品事实**（厂家的叫法）：维护端该能改，
-- 所以它是一列，不是一段推导。旧的本地目录（app/src/data/catalog.js）是这句话
-- 目前唯一的权威来源，种子从它派生（见 R__seed_product_catalog.sql）。

ALTER TABLE `product`
  ADD COLUMN `door_part` VARCHAR(16) NULL COMMENT '门部件名（柜门/双门/上盖）—— 产品事实，不从几何推'
  AFTER `size_note`;
