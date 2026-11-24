-- V8：`door_part` 从"中文名"改为"门型代码"
--
-- 为什么改（V6 把它建成了一列；这一步把它的**取值**定成代码）：
--   中文当枚举在库里有三个具体麻烦：不好索引、没法做多语言、代码里容易写错别字。
--   更要紧的是它要和**内核的门型表**对齐 —— 而内核里那份以前是按**型号名写死**的
--   （demo-freezer-chest→上盖）。同一件事两处说，迟早打架：现在真相只住在这一列。
--
-- 映射（**只改值，不改语义**；界面文案一个字都不变，翻译交给内核 doorPartLabel）：
--   柜门 → single   （立式前门，绕竖轴）
--   双门 → double   （对开，绕竖轴）
--   上盖 → top      （顶开，绕水平轴）
--   （预留 drawer   抽拉，暂无产品用到）
--
-- 幂等：只动这 3 个老值，别的值原样留着（认不出的值内核会**原样显示**并吼一声，不丢信息）。

UPDATE `product`
   SET `door_part` = CASE `door_part`
       WHEN '柜门' THEN 'single'
       WHEN '双门' THEN 'double'
       WHEN '上盖' THEN 'top'
       ELSE `door_part`
     END
 WHERE `door_part` IN ('柜门', '双门', '上盖');

ALTER TABLE `product`
  MODIFY COLUMN `door_part` VARCHAR(16) NULL
  COMMENT '门型代码：single|double|top|drawer —— 产品事实，不从几何推（见 V6 / V8）';
