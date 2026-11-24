-- V4__seed_local_user.sql —— 本机用户（单租户）
--
-- 为什么必须有这一行：`scheme.owner_id` 有外键指向 `sys_user.id`（V1 建的，真库已核 6 个外键）。
-- 没有用户行，第一条方案就插不进去 —— 这不是"种子数据可有可无"，是**外键的硬要求**。
--
-- 为什么 enabled = 0：认证层还没接（G1：将来接统一身份，见 docs/06）。
-- 这一行的唯一职责是**让外键成立**，不是让人登录。
-- password_hash 故意写成不可用的形式（以 `!` 开头是各家框架通行的"不是有效散列"约定），
-- 免得将来认证接上后，某个默认口令悄悄成了后门。
--
-- 单租户口径：一个部署 = 一个内网团队，所有方案都属于 id=1 这个本机用户
-- （服务层 SchemeService.DEFAULT_OWNER_ID = 1 与此对应）。

INSERT INTO `sys_user`
  (`id`, `username`, `password_hash`, `display_name`, `role_code`, `enabled`, `external_id`)
VALUES
  (1, 'local', '!disabled-until-auth-landed', '本机用户', 'admin', 0, NULL);
