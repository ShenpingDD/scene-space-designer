-- V16：账号与登录（U1）
--
-- ## 这一版做什么
--   ① `sys_user` 加 `last_login_at`：维护端用户列表要显示「最后登录时间」。
--   ② 插入两个账号行 `admin`（角色 admin）与 `designer`（角色 designer）：
--      `enabled = 0`、`password_hash` 是占位值。**仓库里一条口令都没有** ——
--      口令由一次性命令 `bash tools/server/set-password.sh <username>` 从控制台读入并写入，
--      该命令同时把 `enabled` 置为 1（见 docs/80 §五第 5 项）。
--   ③ 更正 `V4__seed_local_user.sql` 第 12 行那句注释。已发布的迁移不许改（AGENTS §4），
--      所以更正写在这里：id = 1 的 `local` 行不再是「唯一的用户」，
--      U1 之后它只是账号之一，登录走真实的登录名与口令。
--
-- ## 占位口令哈希的形状
-- `!no-password` 以 `!` 开头，不是任何 BCrypt 哈希的形态，所以**任何口令都对不上它**。
-- 登录时会额外在服务端日志里 WARN 一句（见 `AuthController.warnIfPlaceholder`），
-- 提示「这个账号的口令还没设过」，免得把「口令没设」误判成「口令抄错了」。
-- 维护端用户列表的「口令是否设过」也是照这个形状算的（以 `$2` 开头才算设过）。
--
-- ## 已有数据一动不动
-- 不写 `id`：新行拿自增值，id = 1 的 `local` 行内容与原来逐字节相同
-- （它本来就是 `enabled = 0` + 不可用哈希，所以它登不上）。
-- `id` 只出现在下面的核对语句里。
--
-- ## 跑完去库里核对（不看日志）
--   SELECT id, username, role_code, enabled, last_login_at FROM `sys_user` ORDER BY id;
--     期望三行：id=1 是 `local`（角色 admin、enabled 0、last_login_at 为空），
--     id=2 是 `admin`（角色 admin、enabled 0、last_login_at 为空），
--     id=3 是 `designer`（角色 designer、enabled 0、last_login_at 为空）。
--   SELECT COUNT(*) FROM `sys_user` WHERE `password_hash` = '!no-password';   -- 期望 2
--   SELECT COUNT(*) FROM `sys_user` WHERE `id` = 1 AND `username` = 'local'
--     AND `role_code` = 'admin' AND `enabled` = 0;                            -- 期望 1
--   SHOW COLUMNS FROM `sys_user` LIKE 'last_login_at';                        -- 期望存在、Null=YES

ALTER TABLE `sys_user`
  MODIFY COLUMN `password_hash` VARCHAR(100) NOT NULL
    COMMENT 'BCrypt 60 字符；以 ! 开头的是「还没设过口令」的占位值，任何口令都对不上。留到 100 是为了将来换算法不用改表',
  ADD COLUMN `last_login_at` DATETIME(3) NULL
    COMMENT '最后一次登录成功的时间（登录失败不写）' AFTER `enabled`;

INSERT INTO `sys_user` (`username`, `display_name`, `password_hash`, `role_code`, `enabled`)
VALUES ('admin', '管理员', '!no-password', 'admin', 0),
       ('designer', '设计师', '!no-password', 'designer', 0);
