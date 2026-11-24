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
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * DeliveryStoreContractTest —— 交付记录（`scheme_delivery`）+ 操作日志（`audit_log`）两实现的**同一套契约**
 *
 * 为什么必须有它（`D20/D21` 的教训原文）：`ParamsStore` 当年只有内存实现被断言过，
 * JDBC 那份"从没被跑过"，直到契约测试补上一跑就抓到两个真缺陷。
 * 交付记录这两条 SQL 同样有"只有真库才会露出来的"坑：
 *
 *   · `files_json` 是 **JSON 列** —— 用字符串参数写进去、再读回来，
 *     MySQL 可能重排格式（B4d 实测过：JSON 列会自己加空格），所以只能**按语义比**；
 *   · `with_assets` 是 `TINYINT(1)` —— 读回来必须是 `boolean`（`rs.getBoolean` 在 0/1 上语义正确，
 *     但"写 0/1、读 true/false"这条链从来没被跑过）；
 *   · `LAST_INSERT_ID()` 必须是真的刚写的那一行（写在别的连接上就会串号）。
 *
 * ## 只碰自己造的数据
 *
 * JDBC 侧只写自己创建的那一条方案 + 它的记录；日志用 `target_type = 'probe-contract'`
 * （一个**一眼就看得出是测试**的类型名，不会与 `scheme` 混在一起），收尾按它清掉。
 */
class DeliveryStoreContractTest {

  private static final long OWNER = 1L;
  /** 只给测试用的 target_type —— 与真实动作（`scheme`）分开，收尾好清、也不会污染审计页 */
  private static final String PROBE_TYPE = "probe-contract";

  @Test
  @DisplayName("内存实现 · 契约")
  void inMemoryStore() {
    contract(new DeliveryStoreInMemory(new AuditLogInMemory()), null, "内存");
  }

  @Test
  @DisplayName("JDBC 实现 · 契约（连不上库则 skip，不假装绿）")
  void jdbcStore() {
    final JdbcClient jdbc = jdbcOrNull();
    Assumptions.assumeTrue(jdbc != null,
        "跳过：连不上 MySQL，或这个库还没跑过迁移（这是 skip，不是通过）");
    contract(new DeliveryStoreJdbc(jdbc, new AuditLogJdbc(jdbc)), jdbc, "JDBC");
  }

  private void contract(DeliveryStore store, JdbcClient jdbc, String tag) {
    // 造一份真方案（交付记录有外键指向它），收尾连它一起清
    Long schemeId = null;
    try {
      if (jdbc != null) {
        final org.springframework.jdbc.support.KeyHolder keys =
            new org.springframework.jdbc.support.GeneratedKeyHolder();
        jdbc.sql("INSERT INTO scheme (name, owner_id, room_json, format_version, params_rev, rev) "
                + "VALUES (:name, :owner, '{\"w\":8,\"d\":6,\"h\":2.8,\"walls\":[],\"items\":[]}', "
                + "'probe-contract', 1, 1)")
            .param("name", tag + "·交付契约探针").param("owner", OWNER)
            .update(keys);
        schemeId = keys.getKey().longValue();
      } else {
        schemeId = 987_654L;   // 内存实现没有外键，用一个一眼看出是测试的 id
      }

      final String files = "[{\"name\":\"README.md\",\"bytes\":12,\"checksum\":\"abc\"},"
          + "{\"name\":\"设备清单.csv\",\"bytes\":345,\"checksum\":\"def\"}]";

      // ① 落一条：回给我们的那行必须**就是库里那一行**（不是"我们以为写了什么"）
      final DeliveryStore.DeliveryRow r = store.record(schemeId, 3, 358430008, 7, files, true, "交付手", "第一包");
      assertTrue(r.id() > 0, tag + "：要把新记录的 id 回出来");
      assertEquals(schemeId, r.schemeId(), tag + "：挂对了方案");
      assertEquals(3, r.rev(), tag + "：钉的是第 3 版");
      assertEquals(358430008, r.paramsRev(), tag + "：参数版本一起钉住（对账要用）");
      assertEquals(7, r.catalogRev(), tag + "：目录版本一起钉住");
      assertTrue(r.withAssets(), tag + "：含附件这一位要真的存成 true");
      assertEquals("交付手", r.packagedBy(), tag + "：生成人（名字快照）");
      assertEquals("第一包", r.note(), tag + "：备注");

      // ② 再落一条 → 列表新的在前；**记录只加不改**
      final DeliveryStore.DeliveryRow r2 = store.record(schemeId, 4, 351788645, 7, files, false, "交付手2", "");
      final List<DeliveryStore.DeliveryRow> list = store.list(schemeId);
      assertEquals(2, list.size(), tag + "：两条都在");
      assertEquals(r2.id(), list.get(0).id(), tag + "：**新的在前**（列表头就是最近一次交付）");
      assertEquals(r.id(), list.get(1).id(), tag + "：旧的在后");
      assertFalse(list.get(0).withAssets(), tag + "：false 也要原样读回来（写 0 / 读 true 是最容易错的）");
      assertEquals("", list.get(0).note(), tag + "：没写备注就是空串，不是「没这一列」");

      // ③ files_json 按**语义**比：MySQL 的 JSON 列会重排格式，按文本比会红得莫名其妙
      final Object parsed = list.get(0).filesJson();
      assertTrue(String.valueOf(parsed).contains("README.md"), tag + "：文件清单写得进读得出");
      assertTrue(String.valueOf(parsed).contains("设备清单.csv"), tag + "：中文名也在");

      // ④ 审计：写一条、读得到，且**顺序是新的在前**
      store.writeAudit("交付手", "scheme.delivery-state", PROBE_TYPE, schemeId, "{\"from\":\"delivered\"}");
      store.writeAudit("交付手", "scheme.delivery-state", PROBE_TYPE, schemeId, "{\"to\":\"draft\"}");
      final List<java.util.Map<String, Object>> audit = store.auditOf(PROBE_TYPE, schemeId);
      assertEquals(2, audit.size(), tag + "：两条留痕都在");
      assertTrue(String.valueOf(audit.get(0).get("detail_json")).contains("draft"),
          tag + "：新的在前（界面从最近一条开始读）");
      assertEquals(0, store.auditOf(PROBE_TYPE, schemeId + 1).size(),
          tag + "：别人的留痕不许被带出来（按 target_id 隔离）");

      // ⑤ 不存在的方案：列表给空、不抛（查询路径不许因为"查不到"就 500）
      assertTrue(store.list(schemeId + 1).isEmpty(), tag + "：没有记录的方案 → 空列表");
    } finally {
      if (jdbc != null && schemeId != null) {
        // 先删日志（它没有外键），再删方案（records 有 FK CASCADE 会跟着走）
        jdbc.sql("DELETE FROM audit_log WHERE target_type = :t AND target_id = :id")
            .param("t", PROBE_TYPE).param("id", schemeId).update();
        jdbc.sql("DELETE FROM scheme WHERE id = :id").param("id", schemeId).update();
        jdbc.sql("DELETE FROM scheme_delivery WHERE scheme_id = :id").param("id", schemeId).update();
        System.out.println("[cleanup] 交付契约探针已清掉：scheme " + schemeId);
      }
    }
  }

  // ── 与 SchemeStoreContractTest 同一套连库口径（连不上就 skip，不假装绿）────────────

  private static JdbcClient jdbcOrNull() {
    final String url = "jdbc:mysql://" + env("DB_HOST", "127.0.0.1") + ":" + env("DB_PORT", "3306")
        + "/" + env("DB_NAME", "spatial_design")
        + "?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&useSSL=false&allowPublicKeyRetrieval=true";
    final DriverManagerDataSource ds =
        new DriverManagerDataSource(url, env("DB_USER", "root"), env("DB_PASSWORD", ""));
    try (Connection c = ds.getConnection();
         Statement st = c.createStatement()) {
      try (var rs = st.executeQuery("SELECT COUNT(*) FROM scheme_delivery")) {
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

  private static String env(String k, String def) {
    final String v = System.getenv(k);
    return v == null || v.isBlank() ? def : v;
  }
}