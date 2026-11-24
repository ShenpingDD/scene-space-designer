package com.scene.spatial.admin;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ProductDraftTest —— 新增请求的"进门检查"（R6-2）
 *
 * 这一层的意义：**烂数据不该走到数据库**。一行烂数据进去之后，
 * 前台不认它、内核报 bad-item、维护端列表里又长得像正常的 —— 排查成本极高。
 * 所以进门就拦，而且**一次把所有问题都列出来**（只报第一个的话用户要来回改十几遍）。
 */
class ProductDraftTest {

  private static Map<String, Object> goodProduct() {
    final Map<String, Object> p = new LinkedHashMap<>();
    p.put("modelNo", "DEMO-99L000NEW");
    p.put("name", "测试型号");
    // 声明尺寸（w/d/h）住 recipe_json 里：1:1 尺寸对账的另一半就在这里
    p.put("recipeJson", "{\"id\":\"demo-99x\",\"name\":\"测试型号\",\"w\":700,\"d\":690,\"h\":1000}");
    p.put("sizeNote", "官网图册估读，±20 mm");
    return p;
  }

  private static Map<String, Object> goodModel() {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("sourceFilePath", "/api/assets/abc.glb");
    m.put("unit", "mm");
    m.put("bboxW", 700); m.put("bboxD", 690); m.put("bboxH", 1000);
    return m;
  }

  @Test
  void a_complete_draft_passes() {
    ProductDraft.validate(goodProduct(), goodModel());   // 不抛就是过
  }

  @Test
  void every_problem_is_reported_at_once_not_just_the_first() {
    // ⚠️ 2026-09-30（B5/B6）这里改了预期，理由要留下：
    //    “没有 model”现在是一条**正常的路**（人工代录，决策⑨）而不是“忘了传模型”。
    //    于是同样的空 payload，该报的错是**代录那条路的**（来源 / 尺寸可信度 / 声明尺寸），
    //    而不是模型那条路的（源文件路径 / 单位 / 实测包围盒）—— 报后者等于在要求一件
    //    这份请求根本没声明要做的事。两条路各自“一次攒齐”见这两个用例。
    final IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
        () -> ProductDraft.validate(new LinkedHashMap<>(), new LinkedHashMap<>()));
    final String msg = e.getMessage();
    assertTrue(msg.contains("共 "), "要说清一共几条问题，实际：" + msg);
    assertTrue(msg.contains("modelNo"));
    assertTrue(msg.contains("name"));
    assertTrue(msg.contains("recipeJson"));
    assertTrue(msg.contains("人工代录"), "没有模型 → 走代录那一路，要说清来源该怎么写，实际：" + msg);
    assertTrue(msg.contains("sizeNote"), "代录必须自己说尺寸有多可信，实际：" + msg);
  }

  @Test
  void with_a_model_the_model_problems_are_reported_at_once() {
    // 传了 model（哪怕只传了个空壳）就按**模型那一套**判据报错：
    // 这条钉的是“两条路不许混”——不然一份声称“我有模型”的请求会被按代录放过。
    final IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
        () -> ProductDraft.validate(new LinkedHashMap<>(), new LinkedHashMap<>(Map.of("variant", "v2"))));
    final String msg = e.getMessage();
    assertTrue(msg.contains("modelNo"));
    assertTrue(msg.contains("sourceFilePath"));
    assertTrue(msg.contains("unit"));
    assertTrue(msg.contains("bboxW"), "一次攒齐实测包围盒那三条，实际：" + msg);
  }

  @Test
  void the_catalog_id_must_live_in_recipe_json_and_look_like_a_slug() {
    // ① 缺 id —— 这一条钉的是**真踩过的坑**：目录 id 住在 recipe_json.id，
    //    不在 product 表的任何一列里（上一批做迁移时对错了键，WHERE 永不命中而 Flyway 照样 success）
    final Map<String, Object> p1 = goodProduct();
    p1.put("recipeJson", "{\"name\":\"没有 id\"}");
    final IllegalArgumentException e1 = assertThrows(IllegalArgumentException.class,
        () -> ProductDraft.validate(p1, goodModel()));
    assertTrue(e1.getMessage().contains("recipe_json.id"),
        "提示里要指名道姓说是 recipe_json.id，实际：" + e1.getMessage());

    // ② id 必须是 ASCII slug：它会进 URL 与缓存键
    for (final String badId : new String[] { "中文ID", "DEMO-99", "a".repeat(40), "有 空格" }) {
      final Map<String, Object> p2 = goodProduct();
      p2.put("recipeJson", "{\"id\":\"" + badId + "\"}");
      assertThrows(IllegalArgumentException.class, () -> ProductDraft.validate(p2, goodModel()),
          "应拒收的 id：" + badId);
    }
  }

  @Test
  void unit_must_be_mm() {
    final Map<String, Object> m = goodModel();
    m.put("unit", "m");
    final IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
        () -> ProductDraft.validate(goodProduct(), m));
    assertTrue(e.getMessage().contains("mm"), "要说清必须用 mm，实际：" + e.getMessage());
  }

  @Test
  void with_a_model_it_still_needs_size_note_and_declared_envelope() {
    // 有模型的请求**也要**写 size_note 与声明三轴：没有它们，1:1 尺寸对账永远算不出来，
    // 于是 envelope_ok 只能永远是 NULL（用户 22:18 记的演示产品缺陷就是这个形状）。
    final Map<String, Object> noNote = goodProduct();
    noNote.remove("sizeNote");
    final IllegalArgumentException e1 = assertThrows(IllegalArgumentException.class,
        () -> ProductDraft.validate(noNote, goodModel()));
    assertTrue(e1.getMessage().contains("sizeNote"), "实际：" + e1.getMessage());

    final Map<String, Object> noDims = goodProduct();
    noDims.put("recipeJson", "{\"id\":\"demo-99x\",\"name\":\"测试型号\"}");
    final IllegalArgumentException e2 = assertThrows(IllegalArgumentException.class,
        () -> ProductDraft.validate(noDims, goodModel()));
    assertTrue(e2.getMessage().contains("声明尺寸"), "实际：" + e2.getMessage());
  }

  @Test
  void product_row_defaults_do_not_pretend_the_door_was_auto_verified() {
    // doorSource 的默认值必须是 manual：新增由人确认，写 auto 就是在数据里撒谎
    final Map<String, Object> row = ProductDraft.productRow(goodProduct());
    assertEquals("manual", row.get("doorSource"));
    assertEquals(999, row.get("sortOrder"));       // 排到最后，由人再调 —— 猜个"合适位置"只会让人找不到它
  }
}
