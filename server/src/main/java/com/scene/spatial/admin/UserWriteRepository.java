package com.scene.spatial.admin;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Map;

/**
 * UserWriteRepository —— 用户管理的取数与写数（U1）
 *
 * 与 {@link AdminRepository} 的分工：那个只读、且是维护端各页面共用的取数；
 * 这个只服务 `/api/admin/users`，**读也只读用户管理要的那几列**（含 `password_hash`，
 * 界面要回答"这个号设过口令没有"）。散列只在这一层与认证层之间走，不进任何响应。
 *
 * 每条 SQL 都从动词开头、一句话写完（AGENTS §4：拼 SQL 只拼片段会看不清改了哪张表）。
 */
@Repository
@ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
public class UserWriteRepository {

  private final JdbcClient jdbc;

  public UserWriteRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  /** 全部账号（含停用），按 id 排 —— 用户表是几十行的量级，一次取回来 */
  public List<Map<String, Object>> users() {
    return jdbc.sql("""
        SELECT id, username, display_name, role_code, enabled, password_hash, created_at, last_login_at
          FROM sys_user ORDER BY id
        """).query().listOfRows();
  }

  /** 一个账号（含散列）。改之前必须读它：要拿改前的角色与启用状态做"最后一名管理员"判定 */
  public Map<String, Object> userById(long id) {
    final List<Map<String, Object>> rows = jdbc.sql("""
        SELECT id, username, display_name, role_code, enabled, password_hash, created_at, last_login_at
          FROM sys_user WHERE id = :id
        """).param("id", id).query().listOfRows();
    return rows.isEmpty() ? null : rows.get(0);
  }

  /** 建号。返回自增 id（登录名有唯一键，回查一次就能拿到） */
  public long insertUser(String username, String passwordHash, String displayName, String roleCode,
      boolean enabled) {
    jdbc.sql("""
        INSERT INTO sys_user (username, password_hash, display_name, role_code, enabled)
        VALUES (:username, :hash, :displayName, :roleCode, :enabled)
        """)
        .param("username", username)
        .param("hash", passwordHash)
        .param("displayName", displayName)
        .param("roleCode", roleCode)
        .param("enabled", enabled ? 1 : 0)
        .update();
    return jdbc.sql("SELECT id FROM sys_user WHERE username = :username")
        .param("username", username).query(Long.class).single();
  }

  /** 这个登录名占没占（唯一键 `uk_user_username`）。撞名要先给人一句干净的话，别等着让数据库报错 */
  public long countByUsername(String username) {
    return jdbc.sql("SELECT COUNT(*) FROM sys_user WHERE username = :username")
        .param("username", username).query(Long.class).single();
  }

  /** 改显示名 / 角色 / 启用状态（三个一起给：调用方已经读到了整行，不必做部分更新） */
  public int updateUser(long id, String displayName, String roleCode, boolean enabled) {
    return jdbc.sql("""
        UPDATE sys_user SET display_name = :displayName, role_code = :roleCode, enabled = :enabled
         WHERE id = :id
        """)
        .param("displayName", displayName)
        .param("roleCode", roleCode)
        .param("enabled", enabled ? 1 : 0)
        .param("id", id)
        .update();
  }

  /** 设 / 重置口令。**不动 `enabled`**：启用与停用是另一条动作，两件事分开做才不会互相盖掉 */
  public int updatePassword(long id, String passwordHash) {
    return jdbc.sql("UPDATE sys_user SET password_hash = :hash WHERE id = :id")
        .param("hash", passwordHash).param("id", id).update();
  }

  /** 记一次登录时间。`last_login_at` 由 `V16` 加 */
  public int touchLastLogin(long id) {
    return jdbc.sql("UPDATE sys_user SET last_login_at = NOW(3) WHERE id = :id")
        .param("id", id).update();
  }

  /**
   * 物理删除。**调用方必须先把四处引用数清楚**（见 `UserAdminService`）——
   * 外键会挡下漏数的那一种（翻成 409），但等到外键报错，界面只知道"删不掉"。
   */
  public int deleteUser(long id) {
    return jdbc.sql("DELETE FROM sys_user WHERE id = :id").param("id", id).update();
  }

  /** 这个账号名下的方案数（含已软删的：软删的方案行仍然引用它） */
  public long countSchemes(long ownerId) {
    return count("SELECT COUNT(*) FROM scheme WHERE owner_id = :id", ownerId);
  }

  /**
   * `owner_id → 方案数`（一次取回）。
   *
   * 用户列表要显示"他名下有几份方案"；一个账号一条 `COUNT` 就是 N+1 次查询，
   * 账号多起来之后列表会明显变慢。
   */
  public Map<String, Long> schemeCountByOwner() {
    final Map<String, Long> out = new java.util.LinkedHashMap<>();
    for (final Map<String, Object> row : jdbc.sql("""
        SELECT owner_id, COUNT(*) AS n FROM scheme GROUP BY owner_id
        """).query().listOfRows()) {
      out.put(String.valueOf(row.get("owner_id")),
          row.get("n") instanceof Number n ? n.longValue() : Long.parseLong(String.valueOf(row.get("n"))));
    }
    return out;
  }

  /** 这个账号留下的方案版本记录数（`scheme_revision.created_by` 没有外键，必须显式数） */
  public long countRevisions(long userId) {
    return count("SELECT COUNT(*) FROM scheme_revision WHERE created_by = :id", userId);
  }

  /** 这个账号发出去的分享口令数 */
  public long countShares(long userId) {
    return count("SELECT COUNT(*) FROM scheme_share WHERE created_by = :id", userId);
  }

  /** 这个账号改过参数的次数 */
  public long countConfigs(long userId) {
    return count("SELECT COUNT(*) FROM app_config WHERE updated_by = :id", userId);
  }

  /** 除这个账号之外，还有几名**启用着的管理员**（"最后一名管理员"判定的输入） */
  public long countOtherEnabledAdmins(long userId) {
    return jdbc.sql("""
        SELECT COUNT(*) FROM sys_user
         WHERE role_code = 'admin' AND enabled = 1 AND id <> :id
        """).param("id", userId).query(Long.class).single();
  }

  private long count(String sql, long id) {
    return jdbc.sql(sql).param("id", id).query(Long.class).single();
  }
}
