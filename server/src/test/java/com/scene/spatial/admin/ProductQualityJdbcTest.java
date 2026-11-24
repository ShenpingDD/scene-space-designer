package com.scene.spatial.admin;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ProductQualityJdbcTest —— **写库路径真的会做 1:1 尺寸对账**（用户 22:18 记的缺陷）
 *
 * 症状：`product_model.envelope_mode='1:1'`，`envelope_ok` 却留 NULL。
 * 根因不在判据（判据早就写在维护端角标里），而在于**只有手工编辑那条路会算**，
 * 新增/导入/加变体/LOD 回写这四条路都不会 —— 于是「批量导入的演示产品」天然是 NULL。
 *
 * 这个文件用真库把四条路里最要紧的两条钉住：
 *   ① `createProduct`（导入/新增走它）→ 声明与实测相符 `envelope_ok=1`、超差 `0`、无声明 `NULL`；
 *   ② `finishLod`（LOD 跑完 → 激活）→ 先在**这次导入的事实**上重算，再拿闸门决定是否 active。
 *
 * 为什么用字面量数字：容差（1 mm）被改错时，这里要能抓住；读常量抓不到「常量本身被改错」。
 */
class ProductQualityJdbcTest {

  @Test
  @DisplayName("JDBC · createProduct 就落 envelope_ok：相符=1 / 超差=0 / 无可核对=NULL")
  void createProductReconcilesEnvelopeOnTheImportPath() {
    final JdbcClient jdbc = jdbcOrNull();
    Assumptions.assumeTrue(jdbc != null, "连不上 MySQL，跳过 JDBC 用例");
    final ProductWriteRepository w = new ProductWriteRepository(jdbc);
    final List<Long> mine = new ArrayList<>();
    try {
      // ① 声明 600/700/800，实测一致 → 1
      final long ok = create(w, jdbc, "PROBE-ENV-OK", "{\"id\":\"probe-env-ok\",\"w\":600,\"d\":700,\"h\":800}",
          600, 700, 800, "1:1");
      mine.add(ok);
      assertEquals(1, envelopeOk(jdbc, ok), "相符 → 1");

      // ② 只差一轴 12 mm（> 1 mm 容差）→ 0，且不是靠平均判出来的
      final long off = create(w, jdbc, "PROBE-ENV-OFF", "{\"id\":\"probe-env-off\",\"w\":600,\"d\":700,\"h\":800}",
          600, 712, 800, "1:1");
      mine.add(off);
      assertEquals(0, envelopeOk(jdbc, off), "逐轴：d 差 12 mm → 0");

      // ③ 声明尺寸缺 → 对账的另一半不在，只能 NULL（闸门会 WARN「尺寸未判」，不是悄悄通过）
      final long unjudged = create(w, jdbc, "PROBE-ENV-NONE", "{\"id\":\"probe-env-none\"}",
          600, 700, 800, "1:1");
      mine.add(unjudged);
      assertNull(envelopeOk(jdbc, unjudged), "没有声明尺寸 → 判不了，NULL");

      // ④ fit 模式：声明与实测本来就不同 → 不判（NULL），不是 0
      final long fit = create(w, jdbc, "PROBE-ENV-FIT", "{\"id\":\"probe-env-fit\",\"w\":600,\"d\":700,\"h\":800}",
          660, 770, 880, "fit");
      mine.add(fit);
      assertNull(envelopeOk(jdbc, fit), "fit 是刻意缩放，不该给出对账结论");
    } finally {
      cleanup(jdbc, mine);
    }
  }

  @Test
  @DisplayName("JDBC · QA 对账输入必须带声明三轴，recheck 不得把一致行写回 NULL")
  void qualityInputsCarryDeclaredAxesAndRecheckIsStable() {
    final JdbcClient jdbc = jdbcOrNull();
    Assumptions.assumeTrue(jdbc != null, "连不上 MySQL，跳过 JDBC 用例");
    final ProductWriteRepository w = new ProductWriteRepository(jdbc);
    final long pid = create(w, jdbc, "PROBE-ENV-AXES",
        "{\"id\":\"probe-env-axes\",\"w\":600,\"d\":700,\"h\":800}", 600, 700, 800, "1:1");
    try {
      final Map<String, Object> row = w.envelopeInputs().stream()
          .filter(r -> r.get("product_id") instanceof Number n && n.longValue() == pid)
          .findFirst().orElseThrow();
      assertEquals(3, ProductQuality.envelopeAxes(row.get("declared_w"), row.get("declared_d"),
          row.get("declared_h"), row.get("bbox_w"), row.get("bbox_d"), row.get("bbox_h")).size(),
          "三轴声明都必须带出来；缺一列 QA 会看到 axes=[]");
      final List<Integer> seedBefore = seedEnvelope(jdbc);
      assertEquals(0, w.recheckEnvelopes(), "稳定库重算应为 changed=0；fit 跳过不能计成改动");
      assertEquals(seedBefore, seedEnvelope(jdbc),
          "fit/1:1 的历史 envelope_ok 不能被一次重算抹成 NULL（尤其种子 1–4）");
      assertEquals(1, envelopeOk(jdbc, pid), "重算一致行仍必须是 1，不能写回 NULL");
    } finally {
      cleanup(jdbc, List.of(pid));
    }
  }

  @Test
  @DisplayName("JDBC · finishLod 用导入的事实重算：改过 bbox 后 active 前会看到新读数")
  void finishLodReconcilesAgainBeforeActivating() {
    final JdbcClient jdbc = jdbcOrNull();
    Assumptions.assumeTrue(jdbc != null, "连不上 MySQL，跳过 JDBC 用例");
    final ProductWriteRepository w = new ProductWriteRepository(jdbc);
    final List<Long> mine = new ArrayList<>();
    try {
      final long pid = create(w, jdbc, "PROBE-ENV-LOD",
          "{\"id\":\"probe-env-lod\",\"w\":600,\"d\":700,\"h\":800}", 600, 700, 800, "1:1");
      mine.add(pid);
      final Long mid = w.modelIdOf(pid, "default");
      assertNotNull(mid);
      assertEquals(1, envelopeOk(jdbc, pid), "创建时已落 1");

      // 模拟「导入后又改过实测包围盒」：旧实现这里不会重算，就会留下与声明不符的旧 1
      jdbc.sql("UPDATE product_model SET bbox_h = 930 WHERE id = :id").param("id", mid).update();

      final ProductQuality.Gate gate = w.finishLod(mid, pid, "assets/optimized/probe-env.glb", 88,
          "md5", "{\"levels\":[1]}");
      assertEquals(0, envelopeOk(jdbc, pid), "LOD 回写后必须用新事实重算 → 0");
      assertTrue(gate.warnCount() > 0, "超差是 WARN（结论），不是 BLOCK：" + gate.summary());
      assertEquals("active", status(jdbc, pid), "只有 WARN 的模型照常上岗");
    } finally {
      cleanup(jdbc, mine);
    }
  }

  // ── 夹具 ─────────────────────────────────────────────────────────────

  /** 种子 1–4 的 envelope_ok；顺序固定，用来钉住 recheck 不得改 fit 历史值。 */
  private static List<Integer> seedEnvelope(JdbcClient jdbc) {
    return jdbc.sql("""
        SELECT m.envelope_ok
          FROM product_model m
         WHERE m.product_id BETWEEN 1 AND 4 AND m.variant = 'default'
         ORDER BY m.product_id
        """).query(Integer.class).list();
  }

  private static long create(ProductWriteRepository w, JdbcClient jdbc, String modelNo,
                             String recipeJson, double bw, double bd, double bh, String mode) {
    final Map<String, Object> product = new LinkedHashMap<>();
    product.put("modelNo", modelNo + "-" + System.nanoTime());
    product.put("name", "探针对账用例");
    product.put("origin", ProductDraft.ORIGIN_MANUAL);
    product.put("sizeNote", "探针自己写的，用完即删");
    product.put("doorPart", "single");
    product.put("doorVerified", true);
    product.put("recipeJson", recipeJson);
    final Map<String, Object> model = new LinkedHashMap<>();
    model.put("variant", "default");
    model.put("sourceFilePath", "/api/assets/" + "a".repeat(64) + ".glb");
    model.put("unit", "mm");
    model.put("bboxW", bw); model.put("bboxD", bd); model.put("bboxH", bh);
    model.put("envelopeMode", mode);
    return w.createProduct(ProductDraft.productRow(product), model, List.of(), "quality-test");
  }

  private static Integer envelopeOk(JdbcClient jdbc, long pid) {
        final List<Integer> rows = jdbc.sql(
            "SELECT envelope_ok FROM product_model WHERE product_id = :pid AND variant = 'default'")
        .param("pid", pid).query(Integer.class).list();
    return rows.isEmpty() ? null : rows.get(0);
  }

  private static String status(JdbcClient jdbc, long pid) {
    final List<String> rows = jdbc.sql("SELECT status FROM product WHERE id = :id")
        .param("id", pid).query(String.class).list();
    return rows.isEmpty() ? null : rows.get(0);
  }

  private static void cleanup(JdbcClient jdbc, List<Long> ids) {
    for (final Long id : ids) {
      jdbc.sql("DELETE FROM product WHERE id = :id").param("id", id).update();
    }
  }

  private static JdbcClient jdbcOrNull() {
    final String url = env("XY_DB_URL", "jdbc:mysql://127.0.0.1:3306/spatial_design?useSSL=false"
        + "&allowPublicKeyRetrieval=true&serverTimezone=Asia/Shanghai&characterEncoding=utf8");
    final String user = env("XY_DB_USER", "root");
    final String pass = env("XY_DB_PASSWORD", "");
    try {
      final DriverManagerDataSource ds = new DriverManagerDataSource(url, user, pass);
      ds.setDriverClassName("com.mysql.cj.jdbc.Driver");
      try (Connection c = ds.getConnection(); Statement st = c.createStatement()) {
        try (ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM product")) {
          if (!rs.next()) return null;
        }
      }
      return JdbcClient.create(ds);
    } catch (Exception e) {
      return null;
    }
  }

  private static String env(String key, String fallback) {
    final String v = System.getenv(key);
    return v == null || v.isBlank() ? fallback : v;
  }
}
