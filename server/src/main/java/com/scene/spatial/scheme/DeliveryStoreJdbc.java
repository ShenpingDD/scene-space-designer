package com.scene.spatial.scheme;

import com.scene.spatial.admin.AuditLog;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * DeliveryStoreJdbc —— 落库实现（`spatial.store=jdbc`，默认档）
 *
 * 两条 SQL 都是"只加"：`scheme_delivery` 只 INSERT、`audit_log` 只 INSERT。
 * 交付记录**不许改也不许删** —— 它存在的意义就是"事后能对账"，能被改的记录不叫记录。
 */
@Repository
@ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
public class DeliveryStoreJdbc implements DeliveryStore {

  private final JdbcClient jdbc;
  /** 操作日志自 R6-5 起**住在自己的组件里**（第二个调用方出现时才抽得出形状）—— 见 `AuditLog` */
  private final AuditLog audit;

  public DeliveryStoreJdbc(JdbcClient jdbc, AuditLog audit) {
    this.jdbc = jdbc;
    this.audit = audit;
  }

  private static final String SQL_INSERT =
      "INSERT INTO scheme_delivery "
          + "(scheme_id, rev, params_rev, catalog_rev, files_json, with_assets, packaged_by, packaged_at, note) "
          + "VALUES (:scheme, :rev, :paramsRev, :catalogRev, :files, :withAssets, :by, :now, :note)";

  private static final String SQL_LIST =
      "SELECT id, scheme_id, rev, params_rev, catalog_rev, files_json, with_assets, packaged_by, "
          + "packaged_at, note FROM scheme_delivery WHERE scheme_id = :scheme ORDER BY id DESC";

  private static final String SQL_BY_ID =
      SQL_LIST.replace("WHERE scheme_id = :scheme", "WHERE id = :id");

  @Override
  public DeliveryRow record(long schemeId, int rev, int paramsRev, long catalogRev, String filesJson,
                            boolean withAssets, String packagedBy, String note) {
    final LocalDateTime now = LocalDateTime.now();
    // ⭐ 新 id 用 `GeneratedKeyHolder` 拿（跟 `SchemeStoreJdbc.create` 同一套）——
    //    不用 `SELECT LAST_INSERT_ID()`：JdbcClient 不保证两次调用走同一个连接，
    //    池子给你另一个连接时它会**默默地**给你另一个人的 id（这种错最难查）。
    final org.springframework.jdbc.support.KeyHolder keys =
        new org.springframework.jdbc.support.GeneratedKeyHolder();
    jdbc.sql(SQL_INSERT)
        .param("scheme", schemeId)
        .param("rev", rev)
        .param("paramsRev", paramsRev)
        .param("catalogRev", catalogRev)
        .param("files", filesJson)
        .param("withAssets", withAssets ? 1 : 0)
        .param("by", packagedBy)
        .param("now", now)
        .param("note", note == null ? "" : note)
        .update(keys);
    // **再读一遍**：回给界面的是库里的那一行（JSON 列会被 MySQL 重排格式，拿我们手里的文本冒充它，
    // 就会出现"界面上显示的文件清单与库里实际存的不一样"——而两边看起来都挺像真的）
    return jdbc.sql(SQL_BY_ID).param("id", keys.getKey().longValue())
        .query((rs, i) -> new DeliveryRow(
            rs.getLong("id"), rs.getLong("scheme_id"), rs.getInt("rev"), rs.getInt("params_rev"),
            rs.getLong("catalog_rev"), rs.getString("files_json"), rs.getBoolean("with_assets"),
            rs.getString("packaged_by"), rs.getTimestamp("packaged_at").toLocalDateTime(),
            rs.getString("note")))
        .single();
  }

  @Override
  public List<DeliveryRow> list(long schemeId) {
    return jdbc.sql(SQL_LIST).param("scheme", schemeId).query((rs, i) -> new DeliveryRow(
        rs.getLong("id"), rs.getLong("scheme_id"), rs.getInt("rev"), rs.getInt("params_rev"),
        rs.getLong("catalog_rev"), rs.getString("files_json"), rs.getBoolean("with_assets"),
        rs.getString("packaged_by"), rs.getTimestamp("packaged_at").toLocalDateTime(),
        rs.getString("note"))).list();
  }

  @Override
  public void writeAudit(String actor, String action, String targetType, long targetId, String detailJson) {
    // 只转发：`audit_log` 的 SQL **只有一份**（`AuditLogJdbc`）—— 两处各写一份
    // 就是等着"一边加了列、另一边忘了"（而且两边都不会报错，只是悄悄少记了一个字段）。
    audit.write(actor, action, targetType, String.valueOf(targetId), detailJson);
  }

  @Override
  public List<Map<String, Object>> auditOf(String targetType, long targetId) {
    return audit.listFor(targetType, String.valueOf(targetId));
  }
}