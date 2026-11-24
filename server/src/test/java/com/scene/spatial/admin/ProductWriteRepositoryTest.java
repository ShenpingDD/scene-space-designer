package com.scene.spatial.admin;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ProductWriteRepositoryTest —— 建表事务的静态保障（R6-2）
 *
 * 为什么这种测试值得写：INSERT 里的错（列名写错、漏一列、状态没写）**运行时才炸**，
 * 而且是在"用户点了保存"的那一刻炸。这里把两件最容易出事的事变成会失败的检查：
 *
 *   ① **status 必须写死 draft**。表上这一列的默认值是 'active' —— 谁要是把它做成参数、
 *      或者干脆不写（让默认值生效），没跑完 LOD 的产品就会**立刻对使用者可见**。
 *   ② **NOT NULL 且无默认值的列，一列都不能漏**。对照物是**从真库 information_schema
 *      查出来的列清单**（不是我记得的），所以它盯的是真表结构。
 *
 * 不需要数据库：只读 SQL 常量本身。
 */
class ProductWriteRepositoryTest {

  /** product_model 里"必须显式给值"的列（NOT NULL 且无默认值，去掉 id/时间戳）。 */
  private static final List<String> MODEL_REQUIRED = List.of(
        "bbox_d",
        "bbox_h",
        "bbox_w",
        "file_path",
        "hinge_nodes",
        "lod_json",
        "product_id",
        "product_id");

  /** product 里同样口径的列。 */
  private static final List<String> PRODUCT_REQUIRED = List.of(
        "model_no",
        "recipe_json",
        "recipe_json");

  @Test
  void new_products_are_drafts_not_active() {
    assertEquals("draft", ProductWriteRepository.NEW_PRODUCT_STATUS);
    assertTrue(ProductWriteRepository.SQL_INSERT_PRODUCT.contains("'draft'"),
        "INSERT 里必须出现字面量 'draft'");
    // 这条是真正的防线：不许出现 'active'，也不许把 status 交给参数
    assertFalse(ProductWriteRepository.SQL_INSERT_PRODUCT.contains("'active'"),
        "新增产品**不许**直接写 active（那是 LOD 跑完才有的状态）");
    assertFalse(ProductWriteRepository.SQL_INSERT_PRODUCT.contains(":status"),
        "status 不许做成参数 —— 做成参数就给了调用方误传 active 的机会");
  }

  @Test
  void every_statement_starts_with_a_verb() {
    // 老规矩：拼 SQL 不许只拼片段，每条语句必须以动词开头，否则读的人无法判断它是不是完整的
    for (final String sql : List.of(ProductWriteRepository.SQL_INSERT_PRODUCT,
        ProductWriteRepository.SQL_INSERT_MODEL, ProductWriteRepository.SQL_INSERT_NOTE)) {
      final String head = sql.strip().toUpperCase();
      assertTrue(head.startsWith("INSERT INTO "), "语句必须以 INSERT INTO 开头，实际：" + head.substring(0, 20));
    }
  }

  @Test
  void product_model_insert_covers_every_required_column() {
    for (final String col : MODEL_REQUIRED) {
      assertTrue(ProductWriteRepository.SQL_INSERT_MODEL.contains(col),
          "product_model 漏了一个必填列：" + col + "（运行时才会炸）");
    }
  }

  @Test
  void product_insert_covers_every_required_column() {
    for (final String col : PRODUCT_REQUIRED) {
      assertTrue(ProductWriteRepository.SQL_INSERT_PRODUCT.contains(col),
          "product 漏了一个必填列：" + col + "（运行时才会炸）");
    }
  }

  @Test
  void placeholders_are_named_not_positional() {
    // 用命名占位符（:x）才算自解释；问号占位符在 20 列的插入里是灾难
    for (final String sql : List.of(ProductWriteRepository.SQL_INSERT_PRODUCT,
        ProductWriteRepository.SQL_INSERT_MODEL, ProductWriteRepository.SQL_INSERT_NOTE)) {
      assertFalse(sql.contains("?"), "不要用问号占位符");
      assertTrue(sql.matches("(?s).*:[a-zA-Z]+.*"), "应当使用命名占位符");
    }
  }

  // ── 停用 / 启用（决策③：产品只停用不删除）──

  @Test
  void status_writes_are_whitelisted_and_never_draft() {
    assertEquals(List.of("active", "disabled"), ProductWriteRepository.STATUS_WRITABLE);
    // 'draft' 是"LOD 还没跑完"的内部状态：一个手滑把成品打成 draft，前台会**静默消失**一款，
    // 而界面上看起来只是"停用"。所以它必须被白名单挡住。
    assertThrows(IllegalArgumentException.class, () -> ProductWriteRepository.checkStatusWritable("draft"));
    assertThrows(IllegalArgumentException.class, () -> ProductWriteRepository.checkStatusWritable(""));
    assertThrows(IllegalArgumentException.class, () -> ProductWriteRepository.checkStatusWritable(null));
    assertEquals("disabled", ProductWriteRepository.checkStatusWritable(" disabled "));
  }

  @Test
  void status_write_touches_only_three_columns() {
    final String sql = ProductWriteRepository.SQL_SET_STATUS;
    assertTrue(sql.startsWith("UPDATE product SET "), "只许 UPDATE product");
    for (final String col : List.of("status", "updated_by", "updated_at")) {
      assertTrue(sql.contains(col), "应当写 " + col);
    }
    // ⚠️ 停用是个"还看不看得见"的问题，不是"改它的内容"：产品事实一列都不许出现在这条 SQL 里。
    for (final String col : List.of("name", "model_no", "recipe_json", "door_part", "encoding", "bbox")) {
      assertFalse(sql.contains(col), "停用不许碰产品事实：" + col);
    }
    assertTrue(sql.contains("WHERE id = :pid"), "必须按 id 定位，且要有 WHERE");
  }

  @Test
  void product_edit_sql_only_touches_whitelisted_columns() {
    final String sql = ProductWriteRepository.SQL_UPDATE_PRODUCT_EDIT;
    assertTrue(sql.strip().startsWith("UPDATE product"), "编辑只许 UPDATE product");
    for (final String col : List.of("name", "series", "description", "source_url", "size_note",
        "color", "door_part", "door_verified", "door_source", "recipe_json",
        "updated_by", "updated_at")) {
      assertTrue(sql.contains(col), "编辑应写 " + col);
    }
    assertFalse(sql.contains("model_no"), "modelNo 是产品身份，编辑不许改");
    assertFalse(sql.contains("status"), "编辑不许顺手改 status");
    assertTrue(sql.contains("JSON_SET"), "声明尺寸必须 JSON_SET，保留 recipe_json 其它键");
    for (final String axis : List.of("'$.w'", "'$.d'", "'$.h'")) {
      assertTrue(sql.contains(axis), "JSON_SET 缺声明轴：" + axis);
    }
    assertTrue(sql.contains("WHERE id = :pid"), "必须按 id 定位");
  }

  @Test
  void model_edit_sql_only_touches_display_and_marking_fields() {
    final String sql = ProductWriteRepository.SQL_UPDATE_DEFAULT_MODEL;
    assertTrue(sql.strip().startsWith("UPDATE product_model"), "编辑默认模型只许 UPDATE product_model");
    for (final String col : List.of("thumb_file", "envelope_mode",
        "anisotropy_ok", "hinge_nodes", "updated_at")) {
      assertTrue(sql.contains(col), "模型编辑应写 " + col);
    }
    // ⚠️ 2026-11-23 收紧：envelope_ok **不再由请求/编辑 SQL 透传**。
    // 它是「声明 vs 实测」的结论，必须由 refreshEnvelope 用**库里的新事实**逐轴重算 ——
    // 否则前端（或批量导入脚本）传什么值就落什么值，1:1 模式又会留下 NULL/错的结论。
    assertFalse(sql.contains("envelope_ok"),
        "envelope_ok 必须由 refreshEnvelope 重算，不许编辑请求直接写");
    for (final String col : List.of("file_path", "checksum", "bbox_w", "variant = :variant")) {
      assertFalse(sql.contains(col), "模型编辑不许碰产物/尺寸/变体：" + col);
    }
    assertTrue(sql.contains("variant = 'default'"), "只改默认变体");
    assertTrue(sql.contains("WHERE product_id = :pid"), "按产品定位默认变体");
  }

  @Test
  void envelope_reconciliation_reads_facts_from_the_database() {
    // 「写后重算」的另一半：重算的输入必须**来自库里**（声明尺寸 + 实测包围盒 + 模式），
    // 不能来自请求体。这三条 SQL 一起钉住这条数据流的方向。
    final String inputs = ProductWriteRepository.SQL_ENVELOPE_INPUTS;
    assertTrue(inputs.contains("JSON_UNQUOTE(JSON_EXTRACT(p.recipe_json, '$.w'))")
        || inputs.contains("$.w"), "声明尺寸从 recipe_json 读：" + inputs);
    for (final String col : List.of("bbox_w", "bbox_d", "bbox_h", "envelope_mode", "declared_w")) {
      assertTrue(inputs.contains(col), "对账输入应含 " + col);
    }
    final String update = ProductWriteRepository.SQL_UPDATE_ENVELOPE_OK;
    assertTrue(update.strip().startsWith("UPDATE product_model SET envelope_ok = :envOk"),
        "重算结果只写这一列：" + update);
    assertTrue(ProductWriteRepository.SQL_QUALITY_ROW_BY_MODEL.contains("p.recipe_json"),
        "闸门读的也是库里的事实，不是请求体");
  }

  @Test
  void delete_sql_is_a_complete_product_delete() {
    final String sql = ProductWriteRepository.SQL_DELETE_PRODUCT;
    assertTrue(sql.strip().startsWith("DELETE FROM product "), "删除必须是完整 DELETE 语句");
    assertTrue(sql.contains("WHERE id = :pid"), "删除必须带 WHERE，且按 id");
    assertFalse(sql.contains("product_model"), "子表交给既有 FK CASCADE，不自己拼删除顺序");
  }

  @Test
  void missing_judgement_readings_are_written_as_null_not_as_a_claim() {
    // 缺读数 = 未判 → NULL。写成 1 是"替模型宣称比例正常"（V10 那次 4 个模型全是 1 的假话）；
    // 写成 0 是"判为不正常"，一样是替它下结论。
    assertEquals(null, ProductWriteRepository.nb(null));
    assertEquals(null, ProductWriteRepository.nb("  "));
    assertEquals(Integer.valueOf(0), ProductWriteRepository.nb(0));
    assertEquals(Integer.valueOf(1), ProductWriteRepository.nb(1));
    assertEquals(Integer.valueOf(0), ProductWriteRepository.nb(false));
    assertEquals(Integer.valueOf(1), ProductWriteRepository.nb(true));
    // 这两列必须真的在 INSERT 里（漏了列，规矩再对也写不进去）
    assertTrue(ProductWriteRepository.SQL_INSERT_MODEL.contains("envelope_ok"));
    assertTrue(ProductWriteRepository.SQL_INSERT_MODEL.contains("anisotropy_ok"));
  }
}
