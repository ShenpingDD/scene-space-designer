package com.scene.spatial.admin;

import com.scene.spatial.catalog.DbCatalog;
import com.scene.spatial.catalog.CatalogRepository;
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
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ProductContentJdbcTest —— 真库的 P0 端到端（连不上库/没跑 V18 则 skip，不假装绿）。
 *
 * ## 隔离（2026-11-23 补：此前会写生产库）
 *
 * 整个类跑在**一个事务里，方法结束回滚**（`@Transactional`）：服务层的写也加入同一事务，
 * 所以 `product_content / product_hotspot / product_action` 与 `audit_log` 都不会真的落库。
 * 部署读到的仍是提交前的事实。
 *
 * 宿主只允许取**一张白纸**（没有 content / hotspot / action 的 active 产品，实际是 seed 1）：
 * 若它已经有内容就 `skip`，**绝不 DELETE 别人的行** —— 旧版本正是在这里删掉了宿主的既有内容。
 * 断言写完后，测试收尾不需要「清理」：回滚就是清理。
 */
@SpringBootTest
@Transactional
class ProductContentJdbcTest {

  @Autowired
  private ProductContentService service;

  @Autowired
  private JdbcClient jdbc;

  @Autowired
  private CatalogRepository catalogRepository;

  @Autowired
  private AdminRepository adminRepository;

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
           ORDER BY p.id LIMIT 1
          """).query().listOfRows().get(0);
      productId = ((Number) row.get("id")).longValue();
      catalogId = String.valueOf(row.get("cid"));
      modelNo = String.valueOf(row.get("model_no"));
      // 只借"白纸"宿主：它已经有内容就不跑（绝不删掉别人的行来腾地方）
      final long contentRows = ((Number) row.get("content_rows")).longValue();
      final long hotspotRows = ((Number) row.get("hotspot_rows")).longValue();
      final long actionRows = ((Number) row.get("action_rows")).longValue();
      Assumptions.assumeTrue(contentRows == 0 && hotspotRows == 0 && actionRows == 0,
          "宿主 " + modelNo + " 已有 content/hotspot/action（" + contentRows + "/" + hotspotRows + "/"
              + actionRows + "）—— 不覆盖既有数据，跳过这条真库用例");
    } catch (RuntimeException e) {
      Assumptions.assumeTrue(false, "跳过：连不上 MySQL 或没跑 V18：" + e.getMessage());
    }
  }

  @Test
  @DisplayName("真库：老产品 detail 200；保存+发布后立即可读；热点计数进目录摘要")
  void legacyThenPublishedThenCatalogSummary() {
    // ① 老产品：没有 product_content 行 → 200 legacy-projection；列表摘要也应是 none/0
    final ProductContentService.Detail legacy = service.detail(catalogId);
    assertEquals("legacy-projection", legacy.body().get("source"));
    assertEquals(0, legacy.body().get("publishedRev"));
    final Map<String, Object> before = AdminService.card(
        adminRepository.products().stream().filter(r -> String.valueOf(r.get("model_no")).equals(modelNo))
            .findFirst().orElseThrow(), List.of());
    assertEquals(0, before.get("hotspotCount"));
    assertEquals("none", before.get("contentStatus"));

    // ② 保存内容（只编辑态）→ 发布 → detail 立即可读
    final Map<String, Object> saved = service.saveContent(productId, Map.of(
        "sellingPoints", List.of("真库卖点"),
        "params", List.of(Map.of("key", "容积", "value", "510", "unit", "L", "group", "制冷")),
        "expectedRev", 0), "jdbc-test");
    assertEquals(1, saved.get("rev"));
    final int rev = ((Number) saved.get("rev")).intValue();

    final Map<String, Object> published = service.publish(productId, Map.of("expectedRev", rev), "jdbc-test");
    assertEquals(true, published.get("published"));

    final ProductContentService.Detail d = service.detail(catalogId);
    assertEquals("published", d.body().get("source"));
    assertEquals(rev, d.body().get("publishedRev"));
    assertEquals(List.of("真库卖点"), ((Map<?, ?>) d.body().get("content")).get("sellingPoints"));
    assertNotNull(d.etag());
    final Map<String, Object> after = AdminService.card(
        adminRepository.products().stream().filter(r -> String.valueOf(r.get("model_no")).equals(modelNo))
            .findFirst().orElseThrow(), List.of());
    assertEquals("published", after.get("contentStatus"));
    assertEquals(rev, after.get("publishedRev"));

    // ③ 目录摘要：hotspotCount=0（尚未热点），hasDetail/contentRev 已反映发布
    final Map<String, Object> shaped = DbCatalog.shapeProduct(
        catalogRepository.products().stream().filter(r -> String.valueOf(r.get("model_no")).equals(modelNo))
            .findFirst().orElseThrow(), List.of());
    assertEquals(0, shaped.get("hotspotCount"));
    assertEquals(rev, shaped.get("contentRev"));

    // ④ 合并入口保存一条热点 → 目录摘要 hotspotCount=1，详情只含有效热点
    final Map<String, Object> h = new LinkedHashMap<>();
    h.put("title", "门内托盘");
    h.put("body", "真库说明");
    h.put("nodePath", List.of("root", "door"));
    h.put("nodeIndex", 0);
    h.put("position", Map.of("x", 0.1, "y", 0.5, "z", 0.2));
    h.put("doorState", "open");
    final Map<String, Object> combined = service.saveContent(productId, Map.of(
        "sellingPoints", List.of("真库卖点"),
        "params", List.of(Map.of("key", "容积", "value", "510", "unit", "L", "group", "制冷")),
        "hotspots", List.of(h), "expectedRev", rev), "jdbc-test");
    assertEquals(true, combined.get("published"));
    final long count = jdbc.sql("SELECT COUNT(*) FROM product_hotspot WHERE product_id = :pid")
        .param("pid", productId).query(Long.class).single();
    assertEquals(1L, count);
    final ProductContentService.Detail withHotspot = service.detail(catalogId);
    assertEquals(1, ((Map<?, ?>) withHotspot.body().get("counts")).get("total"));
    final Map<String, Object> listed = AdminService.card(
        adminRepository.products().stream().filter(r -> String.valueOf(r.get("model_no")).equals(modelNo))
            .findFirst().orElseThrow(), List.of());
    assertEquals(1, listed.get("hotspotCount"));
    assertEquals("published", listed.get("contentStatus"));
    assertTrue(((List<?>) withHotspot.body().get("hotspots")).size() == 1);
  }

  @Test
  @DisplayName("真库：106 规范序列（content → hotspots → publish）也能读回")
  void twoStepSequence() {
    final Map<String, Object> saved = service.saveContent(productId, Map.of(
        "sellingPoints", List.of("两步卖点"), "params", List.of(), "expectedRev", 0), "jdbc-test");
    final int rev1 = ((Number) saved.get("rev")).intValue();
    assertEquals(1, rev1);

    final Map<String, Object> h = new LinkedHashMap<>();
    h.put("title", "把手");
    h.put("body", "两步说明");
    h.put("nodePath", List.of("root", "handle"));
    h.put("nodeIndex", 0);
    h.put("position", Map.of("x", 0.2, "y", 0.8, "z", 0.1));
    final Map<String, Object> hs = service.saveHotspots(productId, Map.of(
        "hotspots", List.of(h), "expectedRev", rev1,
        "validation", Map.of("checkedAt", "2026-10-23T14:00:00+08:00",
            "modelFingerprint", "default:test", "unit", "mm", "invalid", List.of())), "jdbc-test");
    final int rev2 = ((Number) hs.get("rev")).intValue();
    assertEquals(2, rev2);

    final Map<String, Object> pub = service.publish(productId, Map.of("expectedRev", rev2), "jdbc-test");
    assertEquals(true, pub.get("published"));
    final ProductContentService.Detail d = service.detail(catalogId);
    assertEquals(1, ((Map<?, ?>) d.body().get("counts")).get("total"));
    assertEquals("两步卖点", ((List<?>) ((Map<?, ?>) d.body().get("content")).get("sellingPoints")).get(0));
  }
}
