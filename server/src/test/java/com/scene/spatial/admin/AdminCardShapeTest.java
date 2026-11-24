package com.scene.spatial.admin;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * 卡片形状的钉子 —— 第 3 轮对抗式审查 `C-15`。
 *
 * 出过的事：停用/启用端点回传的是 {@code AdminRepository.productById()} 的 5 列原始行，
 * 界面拿它**整条替换**列表里的卡片，于是 {@code badges} 是 {@code undefined}，
 * 角标区在 {@code undefined.length} 上抛 {@code TypeError}；同一张卡的汇总行
 * （必须修／该修／已停用）与筛选页签也会漏掉这一款。
 *
 * 这一条钉的是**界面读得到什么，卡片就必须给什么**。名单来自界面自己对一条卡片的取值
 * （`grep -o "p[.][a-zA-Z]*" app/src/admin/ProductCards.vue | sort -u`）。
 * 界面以后加了新的取值键，这个名单要跟着加 —— 否则钉子只会守着老名单。
 */
class AdminCardShapeTest {

  /** 界面从一张卡片上读的**顶层键**（来自 `ProductCards.vue`）。 */
  private static final List<String> UI_KEYS = List.of(
      "id", "recipeId", "modelNo", "name", "status", "color",
      "doorPart", "doorSource", "doorVerified", "updatedBy",
      "model", "variants", "variantCount", "noteCount", "badges");

  /** 一行产品（键是数据库列的别名，不是卡片的键 —— 这一层转换正是出过事的地方） */
  private static Map<String, Object> productRow() {
    final Map<String, Object> r = new LinkedHashMap<>();
    r.put("db_id", 7L);
    r.put("recipe_id", "R7");
    r.put("model_no", "M7");
    r.put("name", "示例产品");
    r.put("status", "disabled");
    r.put("origin", "用户原始模型");
    r.put("variant", "default");
    r.put("file_path", "assets/models/a.glb");
    r.put("envelope_mode", "1:1");
    r.put("envelope_ok", 1);
    r.put("hinge_nodes", "[{\"node\":\"door\",\"axis\":\"y\",\"openAngleDeg\":106}]");
    return r;
  }

  /** 一行模型（来自 `allModels()`，键是 `product_id`） */
  private static Map<String, Object> oneModel() {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("product_id", 7L);
    m.put("variant", "default");
    m.put("file_path", "assets/models/a.glb");
    return m;
  }

  @Test
  void cardSuppliesEveryKeyTheUiReads() {
    final Map<String, Object> card =
        AdminService.card(productRow(), new ArrayList<>(List.of(oneModel())));
    for (final String k : UI_KEYS) {
      assertTrue(card.containsKey(k),
          "卡片少了界面要读的键：" + k + "（C-15：界面整条替换卡片，缺键就会抛错）");
    }
  }

  @Test
  void badgesIsAlwaysAnArray() {
    final Map<String, Object> card = AdminService.card(productRow(), new ArrayList<>(List.of()));
    assertTrue(card.get("badges") instanceof List,
        "badges 不是数组 —— 界面会在它上面取 length（C-15）");
  }

  @Test
  void disabledProductCarriesTheDisabledBadge() {
    final Map<String, Object> card = AdminService.card(productRow(), new ArrayList<>(List.of()));
    final List<?> badges = (List<?>) card.get("badges");
    assertFalse(badges.isEmpty(), "停用的产品一个角标都没有");
    assertTrue(String.valueOf(badges).contains("已停用"),
        "停用的产品没带「已停用」角标：" + badges);
  }

  @Test
  void variantsReflectTheModelRows() {
    final Map<String, Object> card =
        AdminService.card(productRow(), new ArrayList<>(List.of(oneModel())));
    final Object v = card.get("variants");
    assertTrue(v instanceof List, "variants 不是数组");
    assertEquals(1, ((List<?>) v).size(), "传进一条模型行，variants 就该有一条");
  }

  @Test
  void modelCarriesHingeNodesForTheDoorBoard() {
    final Map<String, Object> card =
        AdminService.card(productRow(), new ArrayList<>(List.of(oneModel())));
    final Map<?, ?> model = (Map<?, ?>) card.get("model");
    assertTrue(model.get("hingeNodes") instanceof List, "model.hingeNodes 必须是数组");
    final List<?> nodes = (List<?>) model.get("hingeNodes");
    assertEquals(1, nodes.size());
    assertEquals("door", ((Map<?, ?>) nodes.get(0)).get("node"));
    assertEquals("y", ((Map<?, ?>) nodes.get(0)).get("axis"));
    assertEquals(106, ((Map<?, ?>) nodes.get(0)).get("openAngleDeg"));
  }

  @Test
  void brokenHingeNodesDoesNotBreakTheCard() {
    final Map<String, Object> row = productRow();
    row.put("hinge_nodes", "not-json");
    final Map<String, Object> card = AdminService.card(row, new ArrayList<>(List.of()));
    assertEquals(List.of(), ((Map<?, ?>) card.get("model")).get("hingeNodes"),
        "解析失败要给空数组，不能把整张卡片变成 500");
  }

  @Test
  void contentSummaryIsZeroWhenThereIsNoContentRow() {
    final Map<String, Object> card =
        AdminService.card(productRow(), new ArrayList<>(List.of()));
    assertEquals(0, card.get("hotspotCount"), "没有 product_content 行 → 0 热点");
    assertEquals(0, card.get("contentRev"));
    assertEquals(0, card.get("publishedRev"));
    assertEquals("none", card.get("contentStatus"));
    assertEquals("none", card.get("hotspotStatus"));
  }

  @Test
  void contentSummaryReportsPublishedAndDraftWithoutInventingFailed() {
    final Map<String, Object> published = productRow();
    published.put("hotspot_count", 3L);
    published.put("content_rev", 5L);
    published.put("content_published_rev", 5L);
    final Map<String, Object> p = AdminService.card(published, new ArrayList<>(List.of()));
    assertEquals(3, p.get("hotspotCount"));
    assertEquals(5, p.get("contentRev"));
    assertEquals(5, p.get("publishedRev"));
    assertEquals("published", p.get("contentStatus"));
    assertEquals("published", p.get("hotspotStatus"));

    final Map<String, Object> draft = productRow();
    draft.put("hotspot_count", 2L);
    draft.put("content_rev", 6L);
    draft.put("content_published_rev", 4L);
    final Map<String, Object> d = AdminService.card(draft, new ArrayList<>(List.of()));
    assertEquals(2, d.get("hotspotCount"));
    assertEquals(6, d.get("contentRev"));
    assertEquals(4, d.get("publishedRev"));
    assertEquals("draft", d.get("contentStatus"), "rev > published_rev 就是编辑态未发布");
    assertEquals("draft", d.get("hotspotStatus"));
  }

  @Test
  void cardNeverCarriesRawDatabaseColumnNames() {
    final Map<String, Object> card =
        AdminService.card(productRow(), new ArrayList<>(List.of(oneModel())));
    for (final String raw : List.of("db_id", "model_no", "recipe_id", "file_path")) {
      assertFalse(card.containsKey(raw),
          "卡片里出现了数据库列名 " + raw + " —— 「回原始行」与「回卡片」是两种形状，"
              + "界面只认后者（C-15）");
    }
  }

  /**
   * 端点必须回**卡片**，不许回原始行 —— 这一条才是 `C-15` 真正的回归点。
   *
   * 上面几条钉的是 {@code card()} 的**形状**；但 `C-15` 出事的地方是**接线**
   * （`out.put("product", …)` 那一句引错了方法），形状再对也拦不住它。
   *
   * 为什么用「读源码」而不是「真打一次接口」：`mvn test` 不连库、也没有真角色，
   * 而这里要钉的恰好是那一行调用。本项目已有同型的钉子
   * （`app/test/admin-wizard.test.js` 读 `analyze.js` 钉 `forceContextLoss` 与 `dispose` 的先后）。
   */
  @Test
  void statusEndpointReturnsTheCardNotTheRawRow() throws Exception {
    final String src = java.nio.file.Files.readString(
        java.nio.file.Path.of("src/main/java/com/scene/spatial/admin/ProductAdminController.java"),
        java.nio.charset.StandardCharsets.UTF_8);
    assertTrue(src.contains("out.put(\"product\", admin.productCard(id))"),
        "停用/启用端点没回卡片（C-15）—— 回原始行会让界面的 p.badges 变 undefined 并抛 TypeError");
    assertFalse(src.contains("out.put(\"product\", admin.product(id))"),
        "停用/启用端点又回成原始行了（C-15 复发）");
  }
}