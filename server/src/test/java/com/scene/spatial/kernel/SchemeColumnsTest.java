package com.scene.spatial.kernel;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.scene.spatial.scheme.Canon;

/**
 * SchemeColumnsTest —— W5 矩形柱：Java 侧的格式/白名单/校验镜像。
 *
 * 与 `spatial-core/test/columns*` 是同一条规则的两份实现，逐条对着写：
 *   ① `Layout.Column` + `stateOf` 逐段顺序（columns 在 walls 与 items 之间，空不发射）；
 *   ② 格式换代：新 FORMAT / W4 / W3 全部 `walls`，旧 W2 及更早 `legacy`；
 *   ③ 导入结构校验六个原因码；关系冲突**宽容收下**（叠柱/压设备不拒）；
 *   ④ `Validate.checkItem` 的 `hit-column#id` 在 `hit-wall` 之后；
 *   ⑤ `Canon.of`（create/save 走它）不许把柱剥掉 —— 漏白名单是**不可逆**的数据丢失。
 */
class SchemeColumnsTest {

  private static Catalog catalog() {
    return new Catalog(Cases.CATALOG);
  }

  private static Map<String, Object> state(Object columns) {
    final Map<String, Object> s = new LinkedHashMap<>();
    s.put("w", 8.0);
    s.put("d", 6.0);
    s.put("h", 3.0);
    s.put("walls", List.of());
    if (columns != null) s.put("columns", columns);
    s.put("items", List.of());
    return s;
  }

  private static Map<String, Object> column(int id, double x, double z, double w, double d) {
    return Json.obj("id", id, "x", x, "z", z, "w", w, "d", d);
  }

  private static Map<String, Object> doc(Object columns) {
    return Json.obj("format", Scheme.FORMAT, "state", state(columns));
  }

  private static Scheme.ImportResult importOf(Object columns) {
    return Scheme.importScheme(Json.write(doc(columns), 0), catalog(), false);
  }

  @Test
  @DisplayName("格式标识：新 FORMAT 41 字符；W4/W3 语义仍是 walls；全部旧标识只读")
  void formatAndSemantics() {
    assertEquals("scene-space-designer-scene-routes-columns", Scheme.FORMAT);
    assertEquals(41, Scheme.FORMAT.length(), "新标识 41 字符（V17 的 VARCHAR(64) 容得下）");
    assertTrue(Scheme.FORMAT.length() <= 64, "超过 64 就必须补 Flyway —— 这条断言是那道门");
    assertEquals("scene-space-designer-scene-routes", Scheme.W4_FORMAT);

    // 参数同值（设计决策记录 §四.2 第 5 条）：Java 的柱上限/边长必须来自生成物 `Params`，
    // 也就是与 JS `config/params.default.json` 的 `column.*` 同一组数 —— 三个字面量各钉一次。
    assertEquals(50, Scheme.MAX_COLUMNS);
    assertEquals(50, Params.columnMaxCount);
    assertEquals(0.2, Scheme.COLUMN_MIN_SIDE_M, 1e-12);
    assertEquals(0.2, Params.columnMinSideM, 1e-12);
    assertEquals(3.0, Scheme.COLUMN_MAX_SIDE_M, 1e-12);
    assertEquals(3, Params.columnMaxSideM);
    assertEquals(0.5, Params.columnDefaultSideM, 1e-12);

    for (final String f : List.of(Scheme.FORMAT, Scheme.W4_FORMAT, "scene-space-designer-scene",
        "scene-space-designer-windows", "scene-space-designer-openings", "scene-space-designer",
        "legacy-spatial-v2", "legacy-spatial-v3", "legacy-spatial-doors-v4")) {
      assertTrue(Scheme.ACCEPTED_FORMATS.contains(f), f + " 必须仍在兼容清单里");
    }
    assertEquals(List.of(Scheme.FORMAT, Scheme.W4_FORMAT, "scene-space-designer-scene"),
        Scheme.WALLS_SEMANTICS_FORMATS, "语义表顺序也进比对：新 → W4 → W3");

    assertEquals("walls", Scheme.semanticsOf(Scheme.FORMAT));
    assertEquals("walls", Scheme.semanticsOf(Scheme.W4_FORMAT), "W4 动线方案重开不许退回 legacy");
    assertEquals("walls", Scheme.semanticsOf("scene-space-designer-scene"), "W3 开放场景同一条");
    assertEquals("legacy", Scheme.semanticsOf("scene-space-designer-windows"));
    assertEquals("legacy", Scheme.semanticsOf("scene-space-designer"));
  }

  @Test
  @DisplayName("stateOf 顺序：w,d,h,walls,columns?,items,routes?,view?,roomLabels?；空 columns 不发射")
  void stateOfOrder() {
    final Layout l = new Layout(8, 6, 3);
    l.columns.add(new Layout.Column(1, 4, 3, 0.5, 0.5));
    final Map<String, Object> withColumns = Scheme.stateOf(l);
    assertEquals(List.of("w", "d", "h", "walls", "columns", "items"), new ArrayList<>(withColumns.keySet()),
        "columns 必须在 walls 与 items 之间：" + withColumns.keySet());
    @SuppressWarnings("unchecked")
    final List<Object> cols = (List<Object>) withColumns.get("columns");
    @SuppressWarnings("unchecked")
    final Map<String, Object> c0 = (Map<String, Object>) cols.get(0);
    assertEquals(List.of("id", "x", "z", "w", "d"), new ArrayList<>(c0.keySet()), "字段顺序 id→x→z→w→d");

    final Map<String, Object> noColumns = Scheme.stateOf(new Layout(8, 6, 3));
    assertFalse(noColumns.containsKey("columns"), "空 columns 不许发射（旧方案字节不变）");
    assertEquals(List.of("w", "d", "h", "walls", "items"), new ArrayList<>(noColumns.keySet()));
  }

  @Test
  @DisplayName("往返：含柱方案导出→导入→再导出逐字节一致；1 mm 量化")
  void roundtrip() {
    final Layout l = new Layout(8, 6, 3);
    l.columns.add(new Layout.Column(1, 4.0, 3.0, 0.5, 0.5));
    l.columns.add(new Layout.Column(2, 2.0, 1.0, 0.2, 0.3));
    final String a = Scheme.exportScheme(l);
    final Scheme.ImportResult r = Scheme.importScheme(a, catalog(), false);
    assertTrue(r.ok(), String.valueOf(r.error()));
    assertEquals(2, r.layout().columns.size());
    assertEquals(1, r.layout().columns.get(0).id);
    assertEquals(0.2, r.layout().columns.get(1).w, 1e-12);
    assertEquals(a, Scheme.exportScheme(r.layout()), "同代往返必须逐字节一致");

    // 0.1996 → 1 mm 量化成 0.2（先量化再校验，JS/Java 在边界上判同一边）
    final Scheme.ImportResult q = importOf(List.of(column(1, 4.0, 3.0, 0.1996, 0.5)));
    assertTrue(q.ok(), String.valueOf(q.error()));
    assertEquals(0.2, q.layout().columns.get(0).w, 1e-12);
  }

  @Test
  @DisplayName("导入结构非法：六个原因码各自可辨，且整份拒绝")
  void structuralRejections() {
    assertEquals("bad-column", importOf("not-a-list").error().reason());
    // 文案也钉（设计决策记录：两端 reason 与 message 都必须是**同一句**；
    // JS 侧 columns.js 的同名字符串由 core 的测试钉，这里钉 Java 这一份，改字即红）。
    assertEquals("柱数据不合法（每条柱需要 id 与 x/z/w/d）", importOf("not-a-list").error().message());
    assertEquals("柱编号重复", importOf(List.of(column(1, 4, 3, 0.5, 0.5),
        column(1, 2, 1, 0.5, 0.5))).error().message());
    assertEquals("柱必须完整在场景内", importOf(List.of(column(1, 7.9, 3, 0.5, 0.5))).error().message());
    assertEquals("柱边长小于下限（0.2 m）", importOf(List.of(column(1, 4, 3, 0.199, 0.5))).error().message());
    assertEquals("柱边长超过上限（3.00 m）", importOf(List.of(column(1, 4, 3, 3.001, 0.5))).error().message());
    assertEquals("柱数量超过上限（50 根）", importOf(many(51)).error().message());
    assertEquals("bad-column", importOf(List.of("not-an-object")).error().reason());
    assertEquals("bad-column", importOf(List.of(Json.obj("id", 1, "x", 1, "z", 1, "w", 0.5))).error().reason());
    assertEquals("bad-column", importOf(List.of(column(0, 4, 3, 0.5, 0.5))).error().reason(), "id 必须正整数");
    assertEquals("duplicate-column-id",
        importOf(List.of(column(1, 4, 3, 0.5, 0.5), column(1, 2, 1, 0.5, 0.5))).error().reason());
    assertEquals("column-too-small", importOf(List.of(column(1, 4, 3, 0.199, 0.5))).error().reason());
    assertEquals("column-too-large", importOf(List.of(column(1, 4, 3, 3.001, 0.5))).error().reason());
    assertEquals("column-out-of-scene", importOf(List.of(column(1, 7.9, 3, 0.5, 0.5))).error().reason());
    assertEquals("too-many-columns", importOf(many(51)).error().reason());

    // 边界：0.2 与 3.0 合法；贴边（四角恰在 0..w）合法
    assertTrue(importOf(List.of(column(1, 4, 3, 0.2, 0.2))).ok());
    assertTrue(importOf(List.of(column(1, 4, 3, 3.0, 3.0))).ok());
    assertTrue(importOf(List.of(column(1, 0.1, 0.1, 0.2, 0.2))).ok());
  }

  private static List<Object> many(int n) {
    final List<Object> out = new ArrayList<>();
    for (int i = 1; i <= n; i++) out.add(column(i, 4, 3, 0.5, 0.5));
    return out;
  }

  @Test
  @DisplayName("关系冲突导入宽容：叠柱/压设备收下，不在导入侧拒绝（可修复状态）")
  void relationshipConflictsAreAccepted() {
    // 两根完全重叠的柱：导入收下（写入端才阻断 column-overlap）
    final Scheme.ImportResult r = importOf(List.of(column(1, 4, 3, 0.5, 0.5), column(2, 4, 3, 0.5, 0.5)));
    assertTrue(r.ok(), String.valueOf(r.error()));
    assertEquals(2, r.layout().columns.size());

    // 柱压设备：设备也照收，体检由 Validate 报 hit-column
    final Map<String, Object> s = state(List.of(column(1, 1.0, 1.0, 1.0, 1.0)));
    s.put("items", List.of(Json.obj("id", 1, "p", "demo-cabinet-800", "x", 1.0, "z", 1.0,
        "r", 0, "doorAmount", 0)));
    final Scheme.ImportResult withItem = Scheme.importScheme(
        Json.write(Json.obj("format", Scheme.FORMAT, "state", s), 0), catalog(), false);
    assertTrue(withItem.ok(), String.valueOf(withItem.error()));
  }

  @Test
  @DisplayName("Validate.checkItem：压柱报 hit-column#id；同时碰墙时 hit-wall 优先（旧原因码优先级不变）")
  void checkItemHitColumn() {
    final Layout l = new Layout(8, 6, 3);
    l.columns.add(new Layout.Column(7, 2.0, 2.0, 1.0, 1.0));
    final Layout.Item item = new Layout.Item(1, "demo-cabinet-800", 2.0, 2.0, 0, 0);
    assertEquals("hit-column#7", Validate.checkItem(l, item, catalog()));

    // 把设备挪到墙边：先报 hit-wall（新判据排在旧判据之后）
    final Layout walled = new Layout(8, 6, 3);
    walled.walls.add(Wall.of(0, 3.0, 8, 3.0));
    walled.columns.add(new Layout.Column(7, 4.0, 3.0, 1.0, 1.0));
    final Layout.Item onWall = new Layout.Item(1, "demo-cabinet-800", 4.0, 3.0, 0, 0);
    assertEquals("hit-wall", Validate.checkItem(walled, onWall, catalog()));

    // 不在柱里 → 合法
    final Layout.Item free = new Layout.Item(1, "demo-cabinet-800", 6.0, 5.0, 0, 0);
    assertNull(Validate.checkItem(l, free, catalog()));
  }

  @Test
  @DisplayName("跨语言 fixture：JS exportScheme 的原文 → Java 导入 → Java 导出，必须逐字节相同")
  void crossLanguageFixture() throws Exception {
    // 唯一来源是 core 的 fixture（**JS 写的字节**，设计决策记录的 A3 判据）：
    // Java 侧不许手抄一份"看起来一样"的期望值，也不另存第二份 —— 两份 fixture 迟早会漂。
    final java.nio.file.Path fixture = java.nio.file.Path.of(
        "../spatial-core/test/cases/columns-scheme.json");
    assertTrue(java.nio.file.Files.isRegularFile(fixture),
        "找不到 core 的跨语言 fixture：" + fixture.toAbsolutePath() + "（不允许 skip：缺了就等于没验）");
    final String js = java.nio.file.Files.readString(fixture, java.nio.charset.StandardCharsets.UTF_8);
    final Scheme.ImportResult r = Scheme.importScheme(js, catalog(), false);
    assertTrue(r.ok(), String.valueOf(r.error()));
    assertEquals(2, r.layout().columns.size(), "fixture 里两根柱都要读进来");
    assertEquals(js, Scheme.exportScheme(r.layout()),
        "JS 写出的字节与 Java 写出的字节必须一样（字段顺序/数字最短十进制/空字段省略）");
  }

  @Test
  @DisplayName("Canon.of：含柱方案 create/save 的规范化不许把柱剥掉（FIX-05 不可逆那一类）")
  void canonKeepsColumns() {
    final Map<String, Object> raw = state(List.of(column(1, 4.0, 3.0, 0.5, 0.5)));
    final Canon.Canonical c = Canon.of(raw, catalog());
    @SuppressWarnings("unchecked")
    final List<Object> cols = (List<Object>) c.state().get("columns");
    assertEquals(1, cols.size(), "Canon 是 create/save 的必经之路：这里丢柱 = 落库前就没了");
    @SuppressWarnings("unchecked")
    final Map<String, Object> c0 = (Map<String, Object>) cols.get(0);
    assertEquals(4.0, ((Number) c0.get("x")).doubleValue(), 1e-12);
    assertEquals(1, c.layout().columns.size());
  }
}
