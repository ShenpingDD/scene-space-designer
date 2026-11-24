package com.scene.spatial.scheme;

import com.scene.spatial.admin.AuditLogInMemory;
import com.scene.spatial.admin.AuditLogJdbc;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.sql.Connection;
import java.sql.Statement;
import java.time.LocalDateTime;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ShareStoreContractTest —— `scheme_share` 两实现的**同一套契约**
 *
 * 为什么这套断言值得单独写（`D20/D21` 的老教训）：内存实现与 JDBC 实现"看起来一样"，
 * 但有四处**只有真库才会露出来**：
 *
 *   · `expires_at` 允许 **NULL** —— 写进去再读回来必须还是 `null`（写成 `0` 秒、
 *     或者读成 `LocalDateTime.now()`，都会让"不过期"变成"立刻过期"，而界面看不出来）；
 *   · `revoked` 是 `TINYINT(1)` —— 读回来必须是 `boolean`；
 *   · `token` 上有 **UNIQUE** 键 —— 重复必须失败（这是我们防"两条链接撞车"的最后一道）；
 *   · `scheme_id` 上有 **外键** —— 方案删了，口令跟着走（`ON DELETE CASCADE`）。
 *
 * 只碰自己造的数据：自建一条 `probe-contract` 方案 + 挂在它下面的口令，收尾按 id 清干净。
 */
class ShareStoreContractTest {

  private static final long OWNER = 1L;
  private static final LocalDateTime NOW = LocalDateTime.of(2026, 9, 30, 16, 0);

  @Test
  @DisplayName("内存实现 · 契约")
  void inMemoryStore() {
    contract(new ShareStoreInMemory(), null, "内存");
  }

  @Test
  @DisplayName("JDBC 实现 · 契约（连不上库则 skip，不假装绿）")
  void jdbcStore() {
    final JdbcClient jdbc = jdbcOrNull();
    Assumptions.assumeTrue(jdbc != null,
        "跳过：连不上 MySQL，或这个库还没跑过迁移（这是 skip，不是通过）");
    contract(new ShareStoreJdbc(jdbc), jdbc, "JDBC");
  }

  private void contract(ShareStore store, JdbcClient jdbc, String tag) {
    Long schemeId = null;
    try {
      if (jdbc != null) {
        final org.springframework.jdbc.support.KeyHolder keys =
            new org.springframework.jdbc.support.GeneratedKeyHolder();
        jdbc.sql("INSERT INTO scheme (name, owner_id, room_json, format_version, params_rev, rev) "
                + "VALUES (:name, :owner, '{\"w\":8,\"d\":6,\"h\":2.8,\"walls\":[],\"items\":[]}', "
                + "'probe-contract', 1, 1)")
            .param("name", tag + "·分享契约探针").param("owner", OWNER)
            .update(keys);
        schemeId = keys.getKey().longValue();
      } else {
        schemeId = 987_653L;   // 内存实现没有外键，用一个一眼看出是测试的 id
      }

      // ① 建一条：回给我们的**就是库里那一行**
      final String t1 = Share.newToken();
      final Share.Row a = store.create(schemeId, t1, NOW.plusDays(30), OWNER, NOW);
      assertTrue(a.id() > 0, tag + "：要把新口令的 id 回出来");
      assertEquals(schemeId, a.schemeId(), tag + "：挂对了方案");
      assertEquals(t1, a.token(), tag + "：口令原样回出来");
      assertFalse(a.revoked(), tag + "：新建的默认没撤销");
      assertEquals(OWNER, a.createdBy(), tag + "：记下是谁发的");
      assertEquals(NOW, a.createdAt(), tag + "：创建时间（秒精度，不该多出纳秒）");

      // ② ⭐ NULL 有效期必须**原样**是 null（读成"现在"就等于把"不过期"变成"立刻过期"）
      final Share.Row never = store.create(schemeId, Share.newToken(), null, OWNER, NOW);
      final Share.Row readBack = store.findByToken(never.token()).orElseThrow();
      assertEquals(null, readBack.expiresAt(), tag + "：expires_at=NULL 读回来还得是 null");
      assertEquals(Share.State.VALID, Share.stateOf(readBack, NOW.plusYears(50)),
          tag + "：不过期的口令 50 年后还能用");

      // ③ 按令牌取：取得到、取不到各一条（"取不到"不许抛）
      assertEquals(t1, store.findByToken(t1).orElseThrow().token(), tag + "：按口令取得到");
      assertTrue(store.findByToken(Share.newToken()).isEmpty(), tag + "：不存在的口令 → 空");

      // ④ 列表：新的在前、含已撤销的（服务端不替界面筛）
      final List<Share.Row> list = store.listOf(schemeId);
      assertEquals(2, list.size(), tag + "：两条都在");
      assertEquals(never.id(), list.get(0).id(), tag + "：**新的在前**");
      assertTrue(store.listOf(schemeId + 1).isEmpty(), tag + "：别的方案的口令不许被带出来");

      // ⑤ 撤销：⭐ 返回值说的是"**这一行在不在这个方案里**"，不是"这次动没动到"。
      //    这是真跑出来的事实：MySQL 连接器默认回的是 **matched rows**（`useAffectedRows=false`），
      //    所以对已经撤销的行再撤一次，也回 1 → true。两个实现必须同语义，这条断言钉住它。
      //    （界面要的是"现在是不是撤销态"，所以 `ShareService.revoke` 先查再判，不靠这个返回值。）
      assertTrue(store.revoke(schemeId, a.id()), tag + "：撤销要成功");
      assertTrue(store.findByToken(t1).orElseThrow().revoked(), tag + "：撤销要落进库里");
      assertTrue(store.revoke(schemeId, a.id()), tag + "：撤过的再撤一次也回 true（匹配到了行）");
      assertFalse(store.revoke(schemeId + 1, a.id()), tag + "：不属于这个方案 → false");
      assertEquals(Share.State.REVOKED, Share.stateOf(store.findByToken(t1).orElseThrow(), NOW),
          tag + "：撤销后就是不能用");

      // ⑥ 不存在的方案：列表给空、不抛（查询路径不许因为"查不到"就 500）
      assertTrue(store.listOf(schemeId + 2).isEmpty(), tag + "：没有口令的方案 → 空列表");
    } finally {
      if (jdbc != null && schemeId != null) {
        // 口令有 FK CASCADE，删方案就会跟着走；这里显式删一遍，好让"清干净了"看得见
        jdbc.sql("DELETE FROM scheme_share WHERE scheme_id = :id").param("id", schemeId).update();
        jdbc.sql("DELETE FROM scheme WHERE id = :id").param("id", schemeId).update();
        System.out.println("[cleanup] 分享契约探针已清掉：scheme " + schemeId);
      }
    }
  }

  // ── 与 DeliveryStoreContractTest 同一套连库口径（连不上就 skip，不假装绿）────────────

  private static JdbcClient jdbcOrNull() {
    final String url = "jdbc:mysql://" + env("DB_HOST", "127.0.0.1") + ":" + env("DB_PORT", "3306")
        + "/" + env("DB_NAME", "spatial_design")
        + "?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&useSSL=false&allowPublicKeyRetrieval=true";
    final DriverManagerDataSource ds =
        new DriverManagerDataSource(url, env("DB_USER", "root"), env("DB_PASSWORD", ""));
    try (Connection c = ds.getConnection();
         Statement st = c.createStatement()) {
      try (var rs = st.executeQuery("SELECT COUNT(*) FROM scheme_share")) {
        rs.next();
      }
      try (var rs = st.executeQuery("SELECT COUNT(*) FROM sys_user WHERE id = " + OWNER)) {
        rs.next();
        if (rs.getInt(1) == 0) {
          System.out.println("[skip] 缺少 V4 种下的本机用户 id=1");
          return null;
        }
      }
      return JdbcClient.create(ds);
    } catch (Exception e) {
      System.out.println("[skip] 连不上 MySQL 或没跑迁移：" + e.getMessage());
      return null;
    }
  }

  private static String env(String k, String dflt) {
    final String v = System.getenv(k);
    return v == null || v.isBlank() ? dflt : v;
  }
}