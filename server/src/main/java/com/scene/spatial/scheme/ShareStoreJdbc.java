package com.scene.spatial.scheme;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

/** `scheme_share` 的落库实现（`spatial.store=jdbc`，默认档）。三条 SQL，一条也不删行 */
@Repository
@ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
public class ShareStoreJdbc implements ShareStore {

  private static final String SQL_INSERT =
      "INSERT INTO scheme_share (scheme_id, token, expires_at, revoked, created_by, created_at) "
          + "VALUES (:scheme, :token, :expires, 0, :by, :now)";

  private static final String SQL_LIST =
      "SELECT id, scheme_id, token, expires_at, revoked, created_by, created_at "
          + "FROM scheme_share WHERE scheme_id = :scheme ORDER BY id DESC";

  private static final String SQL_BY_TOKEN =
      "SELECT id, scheme_id, token, expires_at, revoked, created_by, created_at "
          + "FROM scheme_share WHERE token = :token";

  private static final String SQL_REVOKE =
      "UPDATE scheme_share SET revoked = 1 WHERE id = :id AND scheme_id = :scheme";

  private final JdbcClient jdbc;

  public ShareStoreJdbc(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  private static Share.Row map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
    return new Share.Row(
        rs.getLong("id"), rs.getLong("scheme_id"), rs.getString("token"),
        rs.getTimestamp("expires_at") == null ? null : rs.getTimestamp("expires_at").toLocalDateTime(),
        rs.getBoolean("revoked"), rs.getLong("created_by"),
        rs.getTimestamp("created_at").toLocalDateTime());
  }

  @Override
  public Share.Row create(long schemeId, String token, LocalDateTime expiresAt, long createdBy,
                          LocalDateTime now) {
    // 与 `DeliveryStoreJdbc` 同一套：新 id 用 `GeneratedKeyHolder`，不用 `LAST_INSERT_ID()`
    // （JdbcClient 不保证两次调用走同一个连接，池子会**默默地**给你另一个人的 id）
    final org.springframework.jdbc.support.KeyHolder keys =
        new org.springframework.jdbc.support.GeneratedKeyHolder();
    jdbc.sql(SQL_INSERT)
        .param("scheme", schemeId)
        .param("token", token)
        .param("expires", expiresAt)
        .param("by", createdBy)
        .param("now", now.withNano(0))
        .update(keys);
    return jdbc.sql(SQL_BY_TOKEN).param("token", token).query(ShareStoreJdbc::map).single();
  }

  @Override
  public List<Share.Row> listOf(long schemeId) {
    return jdbc.sql(SQL_LIST).param("scheme", schemeId).query(ShareStoreJdbc::map).list();
  }

  @Override
  public Optional<Share.Row> findByToken(String token) {
    return jdbc.sql(SQL_BY_TOKEN).param("token", token).query(ShareStoreJdbc::map).optional();
  }

  @Override
  public boolean revoke(long schemeId, long shareId) {
    return jdbc.sql(SQL_REVOKE).param("id", shareId).param("scheme", schemeId).update() > 0;
  }
}
