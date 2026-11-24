package com.scene.spatial.admin;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.annotation.Transactional;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ProductActionJdbcTest —— V19（产品级动作库 + 热点 actionKey）的真库端到端。
 *
 * ## 隔离（2026-11-23 补：此前会写生产库）
 *
 * 与 ProductContentJdbcTest 同一套办法：类级 `@Transactional`，方法结束**回滚**，
 * 服务层的写加入同一事务 —— `product_action / product_hotspot / product_content` 与
 * `audit_log` 都不会提交（旧版本用 actor `jdbc-action-test` 在 audit 里留下过 2593–2607 那样的行）。
 *
 * 宿主只借**白纸**（没有 content / hotspot / action 的 active 产品，且排除 352/379）；
 * 宿主已有内容就 skip，**绝不 DELETE 既有行**。连不上库 / 没跑 V19 同样 skip（不假装绿）。
 *
 * 钉的四件事：迁移真的落库了（列/唯一键/FK/无热点外键）；动作库与热点引用能往返；
 * 替换动作库会把悬空引用清成 NULL（热点侧没有外键，只能靠这条 SQL）；
 * 没有动作时 actions 退化成 []（旧客户端/旧数据兼容）。
 */
@SpringBootTest
@Transactional
class ProductActionJdbcTest {

  /** 352/379 是既有演示产品，本轮明确不动它们的 content/hotspot。 */
  private static final List<Long> PROTECTED = List.of(352L, 379L);

  @Autowired
  private ProductContentService service;

  @Autowired
  private JdbcClient jdbc;

  private long productId;
  private String catalogId;
  private String modelNo;

  @BeforeEach
  void pickHost() {
    try {
      final Map<String, Object> row = jdbc.sql("""
          SELECT p.id, p.model_no, JSON_UNQUOTE(JSON_EXTRACT(p.recipe_json, '$.id')) AS cid,
                 (SELECT COUNT(*) FROM product_content c WHERE c.product_id = p.id) AS content_rows,
                 (SELECT COUNT(*) FROM product_hotspot h WHERE h.product_id = p.id) AS hotspot_rows,
                 (SELECT COUNT(*) FROM product_action a WHERE a.product_id = p.id) AS action_rows
            FROM product p JOIN product_model m ON m.product_id = p.id AND m.variant = 'default'
           WHERE p.status = 'active' AND p.description <> '' AND m.file_path <> ''
             AND p.id NOT IN (:p1, :p2)
           ORDER BY p.id LIMIT 1
          """).param("p1", PROTECTED.get(0)).param("p2", PROTECTED.get(1))
          .query().listOfRows().get(0);
      productId = ((Number) row.get("id")).longValue();
      catalogId = String.valueOf(row.get("cid"));
      modelNo = String.valueOf(row.get("model_no"));
      final long contentRows = ((Number) row.get("content_rows")).longValue();
      final long hotspotRows = ((Number) row.get("hotspot_rows")).longValue();
      final long actionRows = ((Number) row.get("action_rows")).longValue();
      Assumptions.assumeTrue(contentRows == 0 && hotspotRows == 0 && actionRows == 0,
          "宿主 " + modelNo + " 已有 content/hotspot/action（" + contentRows + "/" + hotspotRows + "/"
              + actionRows + "）—— 不覆盖既有数据，跳过这条真库用例");
    } catch (RuntimeException e) {
      Assumptions.assumeTrue(false, "跳过：连不上 MySQL 或没跑 V19：" + e.getMessage());
    }
  }

  // ── 迁移 ─────────────────────────────────────────────────────────────

  @Test
  @DisplayName("V19：product_action 表/列/唯一键/FK 落库；product_hotspot.action_key 可空且无外键")
  void migrationV19IsApplied() {
    final long table = jdbc.sql("""
        SELECT COUNT(*) FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_action'
        """).query(Long.class).single();
    assertEquals(1L, table, "V19 没跑：product_action 不存在");

    final Map<String, Object> keyCol = column("product_action", "action_key");
    assertEquals("varchar(64)", String.valueOf(keyCol.get("COLUMN_TYPE")).toLowerCase());
    assertEquals("ascii", keyCol.get("CHARACTER_SET_NAME"));
    assertEquals("ascii_bin", keyCol.get("COLLATION_NAME"),
        "动作 key 是 ASCII 标识，排序/比较要二进制语义");
    assertEquals("NO", keyCol.get("IS_NULLABLE"));

    for (final String col : List.of("product_id", "name", "kind", "target_json", "motion_json",
        "sort_order", "updated_by", "created_at", "updated_at")) {
      assertNotNull(column("product_action", col), "V19 漏列：" + col);
    }
    final Map<String, Object> pidCol = column("product_action", "product_id");
    assertEquals("bigint unsigned", String.valueOf(pidCol.get("COLUMN_TYPE")).toLowerCase(),
        "product_id 必须对齐 V18 的 BIGINT UNSIGNED");

    final long uniq = jdbc.sql("""
        SELECT COUNT(DISTINCT COLUMN_NAME) FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_action'
           AND INDEX_NAME = 'uk_action_product_key' AND NON_UNIQUE = 0
        """).query(Long.class).single();
    assertEquals(2L, uniq, "product_id + action_key 必须是唯一键");

    final Map<String, Object> fk = jdbc.sql("""
        SELECT REFERENCED_TABLE_NAME, DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'product_action'
        """).query().listOfRows().get(0);
    assertEquals("product", fk.get("REFERENCED_TABLE_NAME"));
    assertEquals("CASCADE", fk.get("DELETE_RULE"), "删产品时动作库要跟着删");

    final Map<String, Object> hkCol = column("product_hotspot", "action_key");
    assertEquals("YES", hkCol.get("IS_NULLABLE"), "热点可以没有动作（旧数据/纯展示热点）");
    assertEquals("ascii", hkCol.get("CHARACTER_SET_NAME"));
    final long hotspotFk = jdbc.sql("""
        SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_hotspot'
           AND COLUMN_NAME = 'action_key' AND REFERENCED_TABLE_NAME IS NOT NULL
        """).query(Long.class).single();
    assertEquals(0L, hotspotFk, "热点 action_key 刻意不建外键：替换动作库要能先删后插");
  }

  // ── 往返 ─────────────────────────────────────────────────────────────

  @Test
  @DisplayName("真库：动作库 + 热点 actionKey 往返；发布快照内嵌 actions，公开 detail 读回")
  void actionsRoundTripThroughPublish() {
    final Map<String, Object> door = action("door-open", "rotate",
        motion("axis", "y", "angleDeg", 105, "direction", "+",
            "pivotMm", List.of(287.71, 70, 363), "durationMs", 900, "toggle", true));
    final Map<String, Object> saved = service.saveContent(productId, Map.of(
        "sellingPoints", List.of("动作库卖点"), "params", List.of(),
        "actions", List.of(door),
        "hotspots", List.of(hotspot("门内托盘", "door-open")),
        "expectedRev", 0), "jdbc-action-test");
    assertEquals(true, saved.get("published"));

    final Map<String, Object> actionRow = jdbc.sql("""
        SELECT action_key, name, kind, sort_order, target_json, motion_json
          FROM product_action WHERE product_id = :pid
        """).param("pid", productId).query().listOfRows().get(0);
    assertEquals("door-open", actionRow.get("action_key"));
    assertEquals("开门", actionRow.get("name"));
    assertEquals("rotate", actionRow.get("kind"));
    assertEquals(0, ((Number) actionRow.get("sort_order")).intValue());
    assertTrue(String.valueOf(actionRow.get("target_json")).contains("root"));
    assertTrue(String.valueOf(actionRow.get("motion_json")).contains("105"));
    assertTrue(String.valueOf(actionRow.get("motion_json")).contains("pivotMm"));

    final Map<String, Object> hotspotRow = jdbc.sql("""
        SELECT action_key FROM product_hotspot WHERE product_id = :pid
        """).param("pid", productId).query().listOfRows().get(0);
    assertEquals("door-open", hotspotRow.get("action_key"));

    final String snapshot = jdbc.sql("""
        SELECT published_json FROM product_content WHERE product_id = :pid
        """).param("pid", productId).query(String.class).single();
    assertTrue(snapshot.contains("\"actions\""), "发布快照必须内嵌动作库");
    assertTrue(snapshot.contains("door-open"));

    final ProductContentService.Detail d = service.detail(catalogId);
    assertEquals("published", d.body().get("source"));
    final List<?> actions = (List<?>) d.body().get("actions");
    assertEquals(1, actions.size());
    final Map<?, ?> a = (Map<?, ?>) actions.get(0);
    assertEquals("door-open", a.get("key"));
    assertEquals("rotate", a.get("kind"));
    assertEquals(105, ((Number) ((Map<?, ?>) a.get("motion")).get("angleDeg")).intValue());
    final List<?> pivot = (List<?>) ((Map<?, ?>) a.get("motion")).get("pivotMm");
    assertEquals(287.71, ((Number) pivot.get(0)).doubleValue(), 1e-9);
    assertEquals(70.0, ((Number) pivot.get(1)).doubleValue(), 1e-9);
    assertEquals(363.0, ((Number) pivot.get(2)).doubleValue(), 1e-9);
    final Map<?, ?> hv = (Map<?, ?>) ((List<?>) d.body().get("hotspots")).get(0);
    assertEquals("door-open", hv.get("actionKey"));

    // 维护端读取也要带 actions（编辑界面据此渲染动作库）
    final Map<String, Object> admin = service.adminContent(productId);
    assertEquals(1, ((List<?>) admin.get("actions")).size());
    assertEquals("door-open", ((Map<?, ?>) ((List<?>) admin.get("hotspots")).get(0)).get("actionKey"));
  }

  @Test
  @DisplayName("真库：替换动作库后旧热点引用被清成 NULL（不是留悬空 key）")
  void replacingLibraryClearsDanglingHotspotRefs() {
    final Map<String, Object> first = service.saveContent(productId, Map.of(
        "sellingPoints", List.of(), "params", List.of(),
        "actions", List.of(action("door-open", "rotate", motion("axis", "y", "angleDeg", 105))),
        "hotspots", List.of(hotspot("门内托盘", "door-open")),
        "expectedRev", 0), "jdbc-action-test");
    assertEquals(true, first.get("published"));
    final int rev = ((Number) first.get("rev")).intValue();
    assertEquals(1, ((Number) jdbc.sql("SELECT COUNT(*) FROM product_action WHERE product_id = :pid")
        .param("pid", productId).query(Long.class).single()).intValue());

    // 只换动作库、不重写热点：走 draft-only 分支 → repo.saveDraft(..., actions ...)
    final Map<String, Object> second = service.saveContent(productId, Map.of(
        "sellingPoints", List.of(), "params", List.of(),
        "actions", List.of(action("drawer-open", "translate", motion("axis", "z", "distanceMm", 450))),
        "expectedRev", rev), "jdbc-action-test");

    assertEquals(rev + 1, ((Number) second.get("rev")).intValue());
    final List<Map<String, Object>> lib = jdbc.sql("""
        SELECT action_key FROM product_action WHERE product_id = :pid ORDER BY sort_order, id
        """).param("pid", productId).query().listOfRows();
    assertEquals(1, lib.size(), "动作库是整体替换，不是追加");
    assertEquals("drawer-open", lib.get(0).get("action_key"));

    final Map<String, Object> hotspotRow = jdbc.sql("""
        SELECT action_key FROM product_hotspot WHERE product_id = :pid
        """).param("pid", productId).query().listOfRows().get(0);
    assertNull(hotspotRow.get("action_key"), "旧热点引用的动作已被替换掉，必须清成 NULL");

    final Map<String, Object> admin = service.adminContent(productId);
    assertEquals(1, ((List<?>) admin.get("actions")).size());
    final Map<?, ?> hv = (Map<?, ?>) ((List<?>) admin.get("hotspots")).get(0);
    assertTrue(hv.containsKey("actionKey"));
    assertNull(hv.get("actionKey"));
  }

  @Test
  @DisplayName("真库：没有动作库时 actions == []，热点 actionKey == null（旧数据兼容）")
  void emptyLibraryStaysCompatible() {
    final Map<String, Object> saved = service.saveContent(productId, Map.of(
        "sellingPoints", List.of("无动作卖点"), "params", List.of(),
        "hotspots", List.of(hotspot("铭牌", null)),
        "expectedRev", 0), "jdbc-action-test");
    assertEquals(true, saved.get("published"));

    final long count = jdbc.sql("SELECT COUNT(*) FROM product_action WHERE product_id = :pid")
        .param("pid", productId).query(Long.class).single();
    assertEquals(0L, count, "没传 actions 就不许凭空造动作库");

    final ProductContentService.Detail d = service.detail(catalogId);
    assertEquals(List.of(), d.body().get("actions"));
    final Map<?, ?> hv = (Map<?, ?>) ((List<?>) d.body().get("hotspots")).get(0);
    assertTrue(hv.containsKey("actionKey"));
    assertNull(hv.get("actionKey"));

    final Map<String, Object> admin = service.adminContent(productId);
    assertTrue(((List<?>) admin.get("actions")).isEmpty());
    final Map<?, ?> ah = (Map<?, ?>) ((List<?>) admin.get("hotspots")).get(0);
    assertTrue(ah.containsKey("actionKey"));
    assertNull(ah.get("actionKey"));
  }

  // ── 夹具 ─────────────────────────────────────────────────────────────

  private Map<String, Object> column(String table, String column) {
    final List<Map<String, Object>> rows = jdbc.sql("""
        SELECT COLUMN_TYPE, IS_NULLABLE, CHARACTER_SET_NAME, COLLATION_NAME
          FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c
        """).param("t", table).param("c", column).query().listOfRows();
    return rows.isEmpty() ? null : rows.get(0);
  }

  private static Map<String, Object> action(String key, String kind, Map<String, Object> motion) {
    final Map<String, Object> a = new LinkedHashMap<>();
    a.put("key", key);
    a.put("name", "开门");
    a.put("kind", kind);
    a.put("target", Map.of("path", List.of("root", "door"), "index", 0));
    a.put("motion", motion);
    return a;
  }

  private static Map<String, Object> motion(Object... kv) {
    final Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i + 1 < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
    return m;
  }

  private static Map<String, Object> hotspot(String title, String actionKey) {
    final Map<String, Object> h = new LinkedHashMap<>();
    h.put("title", title);
    h.put("body", "真库说明");
    h.put("nodePath", List.of("root", "door"));
    h.put("nodeIndex", 0);
    h.put("position", Map.of("x", 0.1, "y", 0.5, "z", 0.2));
    h.put("doorState", "open");
    if (actionKey != null) h.put("actionKey", actionKey);
    return h;
  }
}
