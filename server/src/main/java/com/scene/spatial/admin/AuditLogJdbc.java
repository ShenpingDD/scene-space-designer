package com.scene.spatial.admin;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/** `audit_log` 的落库实现（唯一一份 SQL —— 见 {@link AuditLog}） */
@Repository
@ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
public class AuditLogJdbc implements AuditLog {

  private static final String SQL_INSERT =
      "INSERT INTO audit_log (actor, action, target_type, target_id, detail_json, created_at) "
          + "VALUES (:actor, :action, :targetType, :targetId, :detail, :now)";

  private static final String SQL_LIST =
      "SELECT id, actor, action, target_type, target_id, detail_json, created_at "
          + "FROM audit_log WHERE target_type = :targetType AND target_id = :targetId ORDER BY id DESC";

  private final JdbcClient jdbc;

  public AuditLogJdbc(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  @Override
  public void write(String actor, String action, String targetType, String targetId, String detailJson) {
    // 列是 `DATETIME`（秒精度）：这里把纳秒截掉，免得库里存的是四舍五入后的时间、
    // 而日志里打印的是另一秒 —— 对不上的时间戳最费人的时间。
    jdbc.sql(SQL_INSERT)
        .param("actor", actor)
        .param("action", action)
        .param("targetType", targetType)
        .param("targetId", targetId)
        .param("detail", detailJson)
        .param("now", LocalDateTime.now().withNano(0))
        .update();
  }

  @Override
  public List<Map<String, Object>> listFor(String targetType, String targetId) {
    return jdbc.sql(SQL_LIST).param("targetType", targetType).param("targetId", targetId)
        .query().listOfRows();
  }
}
