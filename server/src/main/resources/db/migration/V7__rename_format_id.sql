-- V7：格式标识改名 legacy-spatial-doors-v4 → scene-space-designer
--
-- 这是**数据契约**改名，不是找个字改掉那么简单，三件事一起做：
--   ① 写侧：内核的 FORMAT 改成新标识（老标识只进不写）
--   ② 读侧：ACCEPTED_FORMATS **保留全部历史标识** —— 用户手里已有的导出文件、
--      以及库里还没被本迁移改到的老记录，都还要能打开（兼容是功能，不是包袱）
--   ③ 存量：把自己以前写出去的那批（v4）改写成新标识
--
-- 只改 v4，**不动** v2/v3：那两批是"用户当年导入的老文件"的真实记录，
-- 抹掉它们等于抹掉来源。它们靠读侧白名单继续工作。
UPDATE scheme SET format_version = 'scene-space-designer'
 WHERE format_version = 'legacy-spatial-doors-v4';

-- V1 里那句列注释写死了旧标识（已发布迁移不可改写 —— Flyway 校验 checksum），
-- 所以在这里把注释更新掉，别让后来的人对着注释找旧名字。
ALTER TABLE scheme MODIFY COLUMN format_version VARCHAR(32) NOT NULL
  COMMENT '方案格式标识；当前为 scene-space-designer，历史标识仍被读侧接受';
