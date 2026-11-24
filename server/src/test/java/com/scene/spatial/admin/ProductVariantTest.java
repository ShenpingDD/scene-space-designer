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
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ProductVariantTest —— B5（换模型 = 新增 variant）+ B6（人工代录 + origin 留痕）
 *
 * ## 这个文件最值钱的一条是 `lod_writeback_targets_the_right_variant_row`
 *
 * 一个产品可以有多个变体之后，「跑完 LOD 把结果写回去」这件事**必须按行认**。
 * 按 product_id 认的话，症状是**两个变体看起来都有文件、而其中一份是错的** ——
 * 这种错不会报错、不会崩、前台照样能渲染，只是渲染了**另一个变体的模型**。
 * 纯靠读代码看不出来（老代码的注释当初就写着"将来要按 variant 过一遍"），
 * 所以这里用真库把两种顺序各跑一遍。
 *
 * 不需要数据库的那几条（词表 / 变体名 / 人工代录的必填项）就不连库，直接断言。
 */
class ProductVariantTest {

  // ── 不需要库的：纯判据 ────────────────────────────────────────────────

  @Test
  @DisplayName("变体名：没写 = default（落库的默认值），写了就必须是 ASCII slug")
  void variant_defaults_and_shape() {
    assertEquals("default", ProductDraft.variantOf(new LinkedHashMap<>()), "没写变体名 → 落库给 default");
    assertEquals("v2", ProductDraft.variantOf(Map.of("variant", "v2")));
    assertEquals("default", ProductDraft.variantOf(null), "null 模型也要能问（后台作业会问）");

    assertEquals("v2", ProductDraft.validateVariant("v2"));
    assertEquals("25w", ProductDraft.validateVariant("25w"));
    assertEquals("black-2", ProductDraft.validateVariant("black-2"));
    assertThrows(IllegalArgumentException.class, () -> ProductDraft.validateVariant(""));
    assertThrows(IllegalArgumentException.class, () -> ProductDraft.validateVariant("V2"),
        "大写：这一列会进产物文件名与 URL，大小写混用迟早出两份东西");
    assertThrows(IllegalArgumentException.class, () -> ProductDraft.validateVariant("黑色版"));
    assertThrows(IllegalArgumentException.class, () -> ProductDraft.validateVariant("v 2"));
  }

  @Test
  @DisplayName("校验比落库**不能更严**：没写变体名是合法的（这一版踩过）")
  void absent_variant_name_is_legal() {
    // 这条是被测试抓出来的：第一版在 modelBad 里无条件校验变体名，于是"没写"被判成错，
    // 而落库明明会补 default —— 校验比落库更严，等于把一份合法请求拦在门外。
    ProductDraft.validateModelOnly(Map.of(
        "sourceFilePath", "/api/assets/" + "a".repeat(64) + ".glb",
        "unit", "mm", "bboxW", 990, "bboxD", 1980, "bboxH", 871));
  }

  @Test
  @DisplayName("加变体只校验模型那一半：产品字段（型号/目录 id）不该被要求")
  void model_only_check_does_not_demand_product_fields() {
    // 产品是现成的 —— 重复校验它只会把"产品没问题"当成"这个变体没问题"
    ProductDraft.validateModelOnly(Map.of(
        "variant", "v2", "sourceFilePath", "/api/assets/" + "b".repeat(64) + ".glb",
        "unit", "mm", "bboxW", 990, "bboxD", 1980, "bboxH", 871));

    final IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
        () -> ProductDraft.validateModelOnly(Map.of("variant", "v2", "unit", "mm")));
    assertTrue(e.getMessage().contains("sourceFilePath"), "要说清缺什么：" + e.getMessage());
    assertTrue(e.getMessage().contains("bboxW"), "一次攒齐全部问题：" + e.getMessage());
    assertFalse(e.getMessage().contains("modelNo"), "产品那一半不该在这里被要求：" + e.getMessage());
  }

  @Test
  @DisplayName("origin 词表：只有「用户原始模型」算供应商按规范交的")
  void origin_vocabulary() {
    assertTrue(ProductDraft.ORIGINS.contains("人工代录"));
    assertFalse(ProductDraft.originIsManual("用户原始模型"), "这是唯一一个「按规范交的」");
    assertTrue(ProductDraft.originIsManual("官网外观重建"));
    assertTrue(ProductDraft.originIsManual("官网系列外形"));
    assertTrue(ProductDraft.originIsManual("人工代录"));
    assertFalse(ProductDraft.originIsManual(""), "空值不冒充「人凑的」—— 没写就是没写");
    assertFalse(ProductDraft.originIsManual(null));
  }

  @Test
  @DisplayName("人工代录（没有模型）：来源必须写「人工代录」，尺寸可信度必须自己说")
  void manual_entry_needs_origin_and_size_note() {
    final Map<String, Object> product = new LinkedHashMap<>();
    product.put("modelNo", "DEMO-1");
    product.put("name", "代录款");
    product.put("recipeJson", "{\"id\":\"demo-1\",\"w\":990,\"d\":1980,\"h\":871}");

    // ① 什么都不写：来源 + sizeNote 两条都要报出来
    final IllegalArgumentException missing = assertThrows(IllegalArgumentException.class,
        () -> ProductDraft.validate(product, null));
    assertTrue(missing.getMessage().contains("人工代录"), missing.getMessage());
    assertTrue(missing.getMessage().contains("sizeNote"), missing.getMessage());

    // ② 只补来源：还差尺寸可信度
    product.put("origin", "人工代录");
    final IllegalArgumentException noNote = assertThrows(IllegalArgumentException.class,
        () -> ProductDraft.validate(product, null));
    assertTrue(noNote.getMessage().contains("sizeNote"));
    assertFalse(noNote.getMessage().contains("origin（库里的 origin 列）必须写"),
        "来源已经写了，就别再说它缺：" + noNote.getMessage());

    // ③ 补齐：过
    product.put("sizeNote", "官网图册估读，±20 mm");
    ProductDraft.validate(product, null);

    // ④ 没有模型时占地只能靠声明尺寸：w/d/h 缺一个都不行
    product.put("recipeJson", "{\"id\":\"demo-1\",\"w\":990}");
    final IllegalArgumentException noDim = assertThrows(IllegalArgumentException.class,
        () -> ProductDraft.validate(product, null));
    assertTrue(noDim.getMessage().contains("d"), "要说清缺哪个尺寸：" + noDim.getMessage());
    assertTrue(noDim.getMessage().contains("h"), "一次攒齐：" + noDim.getMessage());
  }

  @Test
  @DisplayName("人工代录不许挂模型行：来源写了「人工代录」却又传了模型 → 走模型那一套判据（来源不是判据）")
  void manual_origin_with_a_model_is_checked_as_a_model() {
    // 这一条钉的是"两条路不许混"：传了 model 就按模型校验（要实测包围盒），
    // 而不是因为来源写了「人工代录」就绕过去 —— 绕过去会写出一行没有实测尺寸的模型。
    final Map<String, Object> product = new LinkedHashMap<>();
    product.put("modelNo", "DEMO-1");
    product.put("name", "代录款");
    product.put("origin", "人工代录");
    product.put("sizeNote", "官网图册估读");
    product.put("recipeJson", "{\"id\":\"demo-1\",\"w\":990,\"d\":1980,\"h\":871}");
    final IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
        () -> ProductDraft.validate(product, Map.of("variant", "v2")));
    assertTrue(e.getMessage().contains("sourceFilePath"), e.getMessage());
    assertTrue(e.getMessage().contains("bboxD"), "实测包围盒一个都不能少：" + e.getMessage());
  }

  // ── 要库的：LOD 回写必须认对行 ────────────────────────────────────────

  @Test
  @DisplayName("JDBC · LOD 回写认的是模型行：非默认变体跑完不会动 default 那一份，也不会误把产品转 active")
  void lod_writeback_targets_the_right_variant_row() {
    final JdbcClient jdbc = jdbcOrNull();
    Assumptions.assumeTrue(jdbc != null, "跳过：连不上 MySQL（这是 skip，不是通过）");

    final List<Long> mine = new ArrayList<>();
    try {
      final ProductWriteRepository w = new ProductWriteRepository(jdbc);
      final long pid = createProbeProduct(jdbc, w, mine);

      // 加一个非默认变体
      final Map<String, Object> v2 = new LinkedHashMap<>();
      v2.put("variant", "v2");
      v2.put("sourceFilePath", "/api/assets/" + "d".repeat(64) + ".glb");
      v2.put("unit", "mm");
      v2.put("bboxW", 600); v2.put("bboxD", 700); v2.put("bboxH", 800);
      final long v2Id = w.addVariant(pid, v2, "variant-test");
      mine.add(pid);

      assertEquals(2, w.variantsOf(pid).size(), "现在有两个变体：" + w.variantsOf(pid));
      assertTrue(w.variantExists(pid, "v2"));
      assertFalse(w.variantExists(pid, "v9"));
      final Long defaultId = w.modelIdOf(pid, "default");
      assertNotNull(defaultId, "默认变体那一行必须查得到");

      // 给**非默认**变体跑完 LOD
      w.finishLod(v2Id, pid, "assets/optimized/probe-v2.glb", 4242, "md5-of-v2", "{\"levels\":[1]}");

      final String defaultFile = strOf(jdbc, "SELECT file_path FROM product_model WHERE id = :id", defaultId);
      final String v2File = strOf(jdbc, "SELECT file_path FROM product_model WHERE id = :id", v2Id);
      assertEquals("", defaultFile == null ? "" : defaultFile,
          "⭐ default 那份**一动不动**（按 product_id 回写的话，这里会被 v2 的产物路径盖掉）");
      assertEquals("assets/optimized/probe-v2.glb", v2File);
      assertEquals("draft", strOf(jdbc, "SELECT status FROM product WHERE id = :id", pid),
          "⭐ 非默认变体跑完**不能**把产品转 active：前台只认 default，它还没有模型");

      // 再给默认变体跑完 → 这时才该转 active
      w.finishLod(defaultId, pid, "assets/optimized/probe-default.glb", 99, "md5-of-default", "{\"levels\":[1]}");
      assertEquals("active", strOf(jdbc, "SELECT status FROM product WHERE id = :id", pid),
          "默认变体真有了产物文件 → 产品转 active（这一条同时证明前一步没转是真的没转）");
      assertEquals("assets/optimized/probe-default.glb",
          strOf(jdbc, "SELECT file_path FROM product_model WHERE id = :id", defaultId));
    } finally {
      cleanup(jdbc, mine);
    }
  }

  @Test
  @DisplayName("JDBC · 质量闸门 BLOCK → 产品留在 draft，原因写进 lod_error")
  void blocked_gate_keeps_product_draft() {
    final JdbcClient jdbc = jdbcOrNull();
    Assumptions.assumeTrue(jdbc != null, "连不上 MySQL，跳过 JDBC 用例");
    final ProductWriteRepository w = new ProductWriteRepository(jdbc);
    final List<Long> mine = new ArrayList<>();
    try {
      // 故意缺 size_note：这正是用户 22:18 记的「导入路径没走过质量闸门」的形状之一
      final Map<String, Object> product = new LinkedHashMap<>();
      product.put("modelNo", "PROBE-BLOCK-" + System.nanoTime());
      product.put("name", "探针闸门用例");
      product.put("origin", ProductDraft.ORIGIN_MANUAL);
      product.put("doorPart", "single");
      product.put("doorVerified", true);
      product.put("recipeJson", "{\"id\":\"probe-block\",\"w\":600,\"d\":700,\"h\":800}");
      final Map<String, Object> model = new LinkedHashMap<>();
      model.put("variant", "default");
      model.put("sourceFilePath", "/api/assets/" + "f".repeat(64) + ".glb");
      model.put("unit", "mm");
      model.put("bboxW", 600); model.put("bboxD", 700); model.put("bboxH", 800);
      final long pid = w.createProduct(ProductDraft.productRow(product), model, List.of(), "quality-test");
      mine.add(pid);
      final Long mid = w.modelIdOf(pid, "default");
      assertNotNull(mid);
      // productRow 会给 size_note 兜底「待核实」；这里显式抹成空，模拟「导入时没人写说明」的旧行
      jdbc.sql("UPDATE product SET size_note = '' WHERE id = :id").param("id", pid).update();

      final ProductQuality.Gate gate =
          w.finishLod(mid, pid, "assets/optimized/probe-block.glb", 123, "md5", "{\"levels\":[1]}");
      assertTrue(gate.blocked(), "缺 size_note 必须拦在激活前：" + gate.summary());
      assertEquals("draft", strOf(jdbc, "SELECT status FROM product WHERE id = :id", pid),
          "有 BLOCK 不许转 active");
      final String delta = strOf(jdbc,
          "SELECT delta_vs_source_json FROM product_model WHERE id = :id", mid);
      assertTrue(delta != null && delta.contains("尺寸说明"), "原因要写进 lod_error：" + delta);
    } finally {
      cleanup(jdbc, mine);
    }
  }

  @Test
  @DisplayName("JDBC · 失败原因也按行写：v2 的问题不会挂在 default 身上")
  void lod_failure_is_written_to_the_right_row() {
    final JdbcClient jdbc = jdbcOrNull();
    Assumptions.assumeTrue(jdbc != null, "跳过：连不上 MySQL（这是 skip，不是通过）");

    final List<Long> mine = new ArrayList<>();
    try {
      final ProductWriteRepository w = new ProductWriteRepository(jdbc);
      final long pid = createProbeProduct(jdbc, w, mine);
      final Map<String, Object> v2 = new LinkedHashMap<>();
      v2.put("variant", "v2");
      v2.put("sourceFilePath", "/api/assets/" + "e".repeat(64) + ".glb");
      v2.put("unit", "mm");
      v2.put("bboxW", 600); v2.put("bboxD", 700); v2.put("bboxH", 800);
      final long v2Id = w.addVariant(pid, v2, "variant-test");
      mine.add(pid);

      w.failLod(v2Id, "优化器说源文件读不出来");
      final String defaultDelta = strOf(jdbc,
          "SELECT delta_vs_source_json FROM product_model WHERE id = :id", w.modelIdOf(pid, "default"));
      final String v2Delta = strOf(jdbc,
          "SELECT delta_vs_source_json FROM product_model WHERE id = :id", v2Id);
      assertTrue(defaultDelta == null || !defaultDelta.contains("lodError"),
          "default 那份不该被写上别人的失败原因：" + defaultDelta);
      assertTrue(v2Delta != null && v2Delta.contains("源文件读不出来"), "原因要写在它自己那一行：" + v2Delta);
    } finally {
      cleanup(jdbc, mine);
    }
  }

  // ── 造数据与清理（只碰自己造的，按 id 硬删） ──────────────────────────

  /** 造一款探针产品（默认变体 + 空 file_path），返回 product.id */
  /**
   * 人工代录（没有模型文件）**不许**在 product_model 里留行。
   *
   * 这一条是端到端探针抓到的真缺陷：controller 那层已经分好了“model == null 就不发 LOD 作业”，
   * 但写库这层还无条件调 bindModel(null) → 500（界面上的话是
   * 「入库失败：Cannot invoke "java.util.Map.get(Object)" because "m" is null」）。
   * 即使不抛异常，插出那一行也是坏数据：列表上显示“1 个变体、没就绪”，
   * 后人分不清是“LOD 还没跑完”还是“本来就没交模型”。所以钉在真库上。
   */
  @Test
  @DisplayName("人工代录：没有模型 ⇒ product_model 一行都不许插")
  void manual_entry_writes_no_model_row() {
    final JdbcClient jdbc = jdbcOrNull();
    Assumptions.assumeTrue(jdbc != null, "跳过：连不上 MySQL（这是 skip，不是通过）");

    final List<Long> mine = new ArrayList<>();
    try {
      final ProductWriteRepository w = new ProductWriteRepository(jdbc);
      final Map<String, Object> product = new LinkedHashMap<>();
      product.put("modelNo", "PROBE-MANUAL-" + System.nanoTime());
      product.put("name", "探针人工代录用例");
      product.put("origin", ProductDraft.ORIGIN_MANUAL);
      product.put("sizeNote", "探针自己写的，用完即删");
      product.put("recipeJson", "{\"id\":\"probe-manual\",\"w\":600,\"d\":700,\"h\":800}");
      ProductDraft.validate(product, null);   // 代录那一套判据要认它（与真请求同一条路）

      final long pid = w.createProduct(ProductDraft.productRow(product), null, List.of(), "variant-test");
      mine.add(pid);

      assertEquals(0, Integer.parseInt(strOf(jdbc,
          "SELECT COUNT(*) FROM product_model WHERE product_id = :id", pid)),
          "没有模型文件就不该有模型行（否则列表上会显示“1 个变体、没就绪”，与“LOD 没跑完”分不开）");
      assertEquals("draft", strOf(jdbc, "SELECT status FROM product WHERE id = :id", pid));
      assertEquals(ProductDraft.ORIGIN_MANUAL,
          strOf(jdbc, "SELECT origin FROM product WHERE id = :id", pid), "来源要落库留痕");
    } finally {
      cleanup(jdbc, mine);
    }
  }

  private static long createProbeProduct(JdbcClient jdbc, ProductWriteRepository w, List<Long> mine) {
    final Map<String, Object> product = new LinkedHashMap<>();
    product.put("modelNo", "PROBE-VARIANT-" + System.nanoTime());
    product.put("name", "探针变体用例");
    product.put("origin", ProductDraft.ORIGIN_MANUAL);
    product.put("sizeNote", "探针自己写的，用完即删");
    // 门型必须显式填：空值现在会被质量闸门判成 BLOCK door-missing（没填 ≠ 没有门）
    product.put("doorPart", "single");
    product.put("doorVerified", true);
    product.put("recipeJson", "{\"id\":\"probe-variant\",\"w\":600,\"d\":700,\"h\":800}");
    final Map<String, Object> model = new LinkedHashMap<>();
    model.put("variant", "default");
    model.put("sourceFilePath", "/api/assets/" + "c".repeat(64) + ".glb");
    model.put("unit", "mm");
    model.put("bboxW", 600); model.put("bboxD", 700); model.put("bboxH", 800);
    final long pid = w.createProduct(ProductDraft.productRow(product), model, List.of(), "variant-test");
    mine.add(pid);
    return pid;
  }

  /** 跑完按 id 硬删（product_model 的外键是 ON DELETE CASCADE，删产品就带走了） */
  private static void cleanup(JdbcClient jdbc, List<Long> ids) {
    for (final Long id : ids) {
      jdbc.sql("DELETE FROM product WHERE id = :id").param("id", id).update();
    }
  }

  private static String strOf(JdbcClient jdbc, String sql, Object id) {
    final List<String> rows = jdbc.sql(sql).param("id", id).query(String.class).list();
    return rows.isEmpty() ? null : rows.get(0);
  }

  /** 连不上就先探一下再决定 skip（与 SchemeStoreContractTest 同一个口径）。 */
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

  private static String env(String k, String dflt) {
    final String v = System.getenv(k);
    return v == null || v.isBlank() ? dflt : v;
  }
}