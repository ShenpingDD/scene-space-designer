package com.scene.spatial.params;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * ParamsStoreJdbc —— `app_config` / `config_revision` 的 JDBC 实现
 *
 * `value_json` 是 JSON 列：写的时候当字符串绑（MySQL 会把 `'85'` 当 JSON 数字 85 存），
 * 读回来按 JSON 解析成 `Integer` / `Double` —— **不要自己 `Double.parseDouble` 那个字符串**，
 * 否则 `3` 与 `3.0` 会变成两种值，指纹也跟着飘。
 */
@Repository
@ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
public class ParamsStoreJdbc implements ParamsStore {

  private static final ObjectMapper JSON = new ObjectMapper();

  private static final String SQL_SELECT =
      "SELECT config_key, value_json FROM app_config WHERE scope = :scope AND scope_id = :scopeId";

  /** 一行都没有就 INSERT 上；已存在就改值并把 rev 加一（`updated_by` 一起刷新） */
  private static final String SQL_PUT =
      "INSERT INTO app_config (scope, scope_id, config_key, value_json, value_type, rev, updated_by) "
          + "VALUES (:scope, :scopeId, :key, :json, :type, 1, :by) "
          + "ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), value_type = VALUES(value_type), "
          + "rev = rev + 1, updated_by = VALUES(updated_by)";

  private static final String SQL_AUDIT =
      "INSERT INTO config_revision (config_key, scope, scope_id, rev, old_json, new_json, snapshot_json, "
          + "changed_by, note) VALUES (:key, :scope, :scopeId, :rev, :oldJson, :newJson, :snapshot, :by, :note)";

  private static final String SQL_LAST_AT =
      "SELECT MAX(changed_at) FROM config_revision WHERE scope = :scope AND scope_id = :scopeId";

  /** 审计要读的列。**不含 snapshot_json** —— 列表带上它等于把整表拖出来（详情才取） */
  private static final String SQL_AUDIT_COLS =
      "SELECT id, config_key, rev, old_json, new_json, changed_by, changed_at, note"
          + " FROM config_revision";

  /** 详情那条：**只在它这里**带 snapshot_json（列表不带，见 SQL_AUDIT_COLS 的注释） */
  private static final String SQL_AUDIT_ONE =
      "SELECT id, config_key, rev, old_json, new_json, changed_by, changed_at, note, snapshot_json"
          + " FROM config_revision WHERE id = :id";

  /**
   * 按**参数版本**取那一版的值（B4d 用）。
   *
   * ⚠️ 必须是一条**自己的**语句，而且要 `ORDER BY id DESC LIMIT 1`：
   *    同一个 `rev` 可能有**好几行**（改回原值、连着发同一版，指纹都会撞在同一个数上 ——
   *    库里现在就有 6 行共用 351788645）。第一版图省事写了 `详情那条.replace(WHERE id…)`，
   *    而 `.optional()` 的契约是"**0 或 1** 行" → 撞上 6 行直接抛
   *    `IncorrectResultSizeDataAccessException`（表现是 500，而看起来像"参数没生效"）。
   *    讽刺的是，当时那句注释里**正写着"可能有好几行"** —— 注释与代码说的不是一件事。
   */
  private static final String SQL_AUDIT_BY_REV =
      "SELECT id, config_key, rev, old_json, new_json, changed_by, changed_at, note, snapshot_json"
          + " FROM config_revision WHERE rev = :rev ORDER BY id DESC LIMIT 1";

  private static final String SQL_AUDIT_COUNT =
      "SELECT COUNT(*) FROM config_revision";

  private final JdbcClient jdbc;

  public ParamsStoreJdbc(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  @Override
  public Map<String, Object> values(String scope, String scopeId) {
    final List<Map<String, Object>> rows = jdbc.sql(SQL_SELECT)
        .param("scope", scope).param("scopeId", scopeId)
        .query((rs, i) -> {
          final Map<String, Object> m = new LinkedHashMap<String, Object>();
          m.put("key", rs.getString("config_key"));
          m.put("json", rs.getString("value_json"));
          return m;
        }).list();
    final Map<String, Object> out = new LinkedHashMap<>();
    for (final Map<String, Object> r : rows) {
      out.put(String.valueOf(r.get("key")), parse(String.valueOf(r.get("json"))));
    }
    return out;
  }

  private static Object parse(String json) {
    try {
      return JSON.readValue(json, Object.class);
    } catch (Exception e) {
      // 库里存了不是 JSON 的东西：**说出来**，并且不让它悄悄变成 null 值参与规则计算
      throw new IllegalStateException("app_config 里有读不了的 value_json：" + json, e);
    }
  }

  @Override
  public int put(String scope, String scopeId, String path, Object value, String valueType, Long updatedBy) {
    jdbc.sql(SQL_PUT)
        .param("scope", scope).param("scopeId", scopeId).param("key", path)
        .param("json", toJson(value)).param("type", valueType).param("by", updatedBy)
        .update();
    final Integer rev = jdbc.sql("SELECT rev FROM app_config WHERE scope = :scope AND scope_id = :scopeId "
            + "AND config_key = :key")
        .param("scope", scope).param("scopeId", scopeId).param("key", path)
        .query(Integer.class).single();
    return rev == null ? 1 : rev;
  }

  private static String toJson(Object v) {
    try {
      return JSON.writeValueAsString(v);
    } catch (Exception e) {
      throw new IllegalArgumentException("写不进 JSON 的值：" + v, e);
    }
  }

  @Override
  public void audit(AuditRow row) {
    jdbc.sql(SQL_AUDIT)
        .param("key", row.path()).param("scope", row.scope()).param("scopeId", row.scopeId())
        .param("rev", row.rev())
        .param("oldJson", row.oldValue() == null ? null : toJson(row.oldValue()))
        .param("newJson", toJson(row.newValue()))
        .param("snapshot", toJson(row.snapshot()))
        .param("by", row.changedBy() == null ? "" : row.changedBy())
        .param("note", row.note() == null ? "" : row.note())
        .update();
  }

  @Override
  public LocalDateTime lastChangedAt(String scope, String scopeId) {
    return jdbc.sql(SQL_LAST_AT).param("scope", scope).param("scopeId", scopeId)
        .query(LocalDateTime.class).optional().orElse(null);
  }

  @Override
  public int countAudit(AuditQuery q) {
    return jdbc.sql(SQL_AUDIT_COUNT + where(q)).params(auditParams(q))
        .query(Integer.class).single();
  }

  @Override
  public List<AuditItem> auditPage(AuditQuery q) {
    final Map<String, Object> p = auditParams(q);
    p.put("limit", q.limit());
    p.put("offset", q.offset());
    return jdbc.sql(SQL_AUDIT_COLS + where(q) + " ORDER BY id DESC LIMIT :limit OFFSET :offset")
        .params(p)
        .query((rs, i) -> item(rs))
        .list();
  }

  @Override
  public AuditItem snapshotOf(int rev) {
    // 同一个 rev 可能有好几行（改回原值、连发同一版）→ 取最新的那一行
    return jdbc.sql(SQL_AUDIT_BY_REV)
        .param("rev", rev)
        .query((rs, i) -> item(rs)).optional().orElse(null);
  }

  @Override
  public AuditItem auditOne(long id) {
    // 详情**单独取 snapshot_json**：列表里不带它，详情必须带（B4d 要用它复现当时的结论）
    return jdbc.sql(SQL_AUDIT_ONE)
        .param("id", id)
        .query((rs, i) -> item(rs))
        .optional().orElse(null);
  }

  /**
   * 条件都为空就不筛；每一维都用 `:名字`（**绝不拼进 SQL 字符串** ——
   * 审计的筛选值是用户填的，拼进去就是注入）。
   *
   * 顺序固定：**新库换版本时这条 SQL 也要跟着改**，所以条件必须只有一个出处。
   */
  private static String where(AuditQuery q) {
    final StringBuilder w = new StringBuilder(" WHERE scope = :scope AND scope_id = :scopeId");
    if (q.from() != null) w.append(" AND changed_at >= :from");
    if (q.to() != null) w.append(" AND changed_at <= :to");
    if (q.path() != null) w.append(" AND config_key = :key");
    if (q.changedBy() != null) w.append(" AND changed_by = :by");
    return w.toString();
  }

  private static Map<String, Object> auditParams(AuditQuery q) {
    final Map<String, Object> p = new LinkedHashMap<>();
    p.put("scope", SCOPE_GLOBAL);
    p.put("scopeId", SCOPE_ID_NONE);
    if (q.from() != null) p.put("from", Timestamp.valueOf(q.from()));
    if (q.to() != null) p.put("to", Timestamp.valueOf(q.to()));
    if (q.path() != null) p.put("key", q.path());
    if (q.changedBy() != null) p.put("by", q.changedBy());
    return p;
  }

  /**
   * 一行 → `AuditItem`。**列缺了就是缺了**：`snapshot_json` 不在 `SQL_AUDIT_COLS` 里时
   * `getString` 抛异常而不是悄悄给 null —— 免得列表路径上误带上快照还看不出来。
   */
  private static AuditItem item(ResultSet rs) throws SQLException {
    return new AuditItem(
        rs.getLong("id"),
        rs.getString("config_key"),
        rs.getInt("rev"),
        parse(rs.getString("old_json")),
        parse(rs.getString("new_json")),
        rs.getString("changed_by"),
        ldt(rs.getObject("changed_at")),
        rs.getString("note"),
        has(rs, "snapshot_json") ? asMap(parse(rs.getString("snapshot_json"))) : Map.of());
  }

  /** 结果集里到底有没有这一列（详情带了、列表没带） */
  private static boolean has(ResultSet rs, String col) {
    try {
      rs.findColumn(col);
      return true;
    } catch (SQLException e) {
      return false;
    }
  }

  private static Map<String, Object> asMap(Object o) {
    if (!(o instanceof Map)) return Map.of();      // 库里存了别的形状：当成"没有快照"，不假装有
    final Map<String, Object> out = new LinkedHashMap<>();
    for (final Map.Entry<?, ?> e : ((Map<?, ?>) o).entrySet()) out.put(String.valueOf(e.getKey()), e.getValue());
    return out;
  }

  /** `changed_at` 回来可能是 `Timestamp`、也可能是驱动给的 `LocalDateTime` —— 两种都认 */
  private static LocalDateTime ldt(Object o) {
    if (o == null) return null;
    if (o instanceof Timestamp t) return t.toLocalDateTime();
    if (o instanceof LocalDateTime d) return d;
    if (o instanceof java.sql.Date d) return d.toLocalDate().atStartOfDay();
    return LocalDateTime.parse(String.valueOf(o).replace(' ', 'T'));
  }
}