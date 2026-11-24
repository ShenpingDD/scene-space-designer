-- 00-create-database.sql —— 建库（只跑一次）
-- 迁移脚本不建库：建库是运维动作，Flyway 只负责**库内**的版本演进

CREATE DATABASE IF NOT EXISTS `spatial_design`
  DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_0900_ai_ci;

-- 开发期建议单独建账号，别用 root（上线账号由运维定）
-- CREATE USER 'app'@'%' IDENTIFIED BY '<换个真密码>';
-- GRANT ALL PRIVILEGES ON `spatial_design`.* TO 'app'@'%';
-- FLUSH PRIVILEGES;
