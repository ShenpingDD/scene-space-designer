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

/**
 * SchemeRoutesTest —— W4 人员地面动线：Java 侧的**格式镜像**（docs/97 §四、§六）。
 *
 * 与 `spatial-core/test/route-format.test.js` 是同一条规则的两份实现，所以这里逐条对着写：
 *   ① `FORMAT` 换代、W3（`-scene`）继续兼容且**语义仍是 `walls`**（开放场景不许回归）；
 *   ② `stateOf` 白名单发射 `routes`（顺序 `w,d,h,walls,items,routes?`），空 routes 不发射；
 *   ③ `importScheme` 结构校验：坏 routes **整份拒绝**、四个原因码与 JS 同名同句；
 *   ④ 点容差与外墙同一条纪律（1e-6），并且**服务端不寻路**（只镜像形状）。
 */
class SchemeRoutesTest {

  private static Catalog catalog() {
    return new Catalog(Cases.CATALOG);
  }

  private static Map<String, Object> doc(String format, Map<String, Object> state) {
    return Json.obj("format", format, "state", state);
  }

  private static Map<String, Object> state(Object routes) {
    final Map<String, Object> s = new LinkedHashMap<>();
    s.put("w", 8.0);
    s.put("d", 6.0);
    s.put("h", 3.0);
    s.put("walls", List.of());
    s.put("items", List.of());
    if (routes != null) s.put("routes", routes);
    return s;
  }

  private static List<Object> pts(double... xz) {
    final List<Object> out = new ArrayList<>();
    for (int i = 0; i + 1 < xz.length; i += 2) out.add(Json.arr(xz[i], xz[i + 1]));
    return out;
  }

  private static Map<String, Object> route(int id, String name, List<Object> points) {
    final Map<String, Object> r = new LinkedHashMap<>();
    r.put("id", id);
    if (name != null) r.put("name", name);
    r.put("points", points);
    return r;
  }

  private static Scheme.ImportResult importOf(Object routes) {
    return Scheme.importScheme(Json.write(doc(Scheme.FORMAT, state(routes)), 0), catalog(), false);
  }

  private static Layout layoutWithRoutes() {
    final Layout l = new Layout(8, 6, 3);
    l.routes.add(new Layout.Route(1, "主动线",
        List.of(new double[]{1.2, 1}, new double[]{4, 1}, new double[]{4, 3})));
    l.routes.add(new Layout.Route(2, null, List.of(new double[]{0, 0}, new double[]{8, 6})));
    return l;
  }

  @Test
  @DisplayName("格式标识换代：新标识 + W3 兼容且语义仍是 walls（旧标识一个都不删）")
  void formatAndSemantics() {
    assertEquals("scene-space-designer-scene-routes-columns", Scheme.FORMAT);
    assertEquals("scene-space-designer-scene-routes", Scheme.W4_FORMAT, "W4 仍是只读历史（语义 walls）");
    for (final String f : List.of("scene-space-designer-scene-routes-columns", "scene-space-designer-scene-routes", "scene-space-designer-scene",
        "scene-space-designer-windows", "scene-space-designer-openings", "scene-space-designer",
        "legacy-spatial-v2", "legacy-spatial-v3", "legacy-spatial-doors-v4")) {
      assertTrue(Scheme.ACCEPTED_FORMATS.contains(f), f + " 必须仍在兼容清单里");
    }
    assertEquals("walls", Scheme.semanticsOf(Scheme.FORMAT));
    assertEquals("walls", Scheme.semanticsOf("scene-space-designer-scene"), "W3 → walls（不许退回 legacy）");
    assertEquals("legacy", Scheme.semanticsOf("scene-space-designer-windows"));

    // 旧 W3 文件（没有 routes）打开：语义 walls、routes 空数组
    final Scheme.ImportResult w3 = Scheme.importScheme(
        Json.write(doc("scene-space-designer-scene", state(null)), 0), catalog(), false);
    assertTrue(w3.ok(), String.valueOf(w3.error()));
    assertEquals("walls", w3.roomSemantics());
    assertTrue(w3.layout().routes.isEmpty(), "旧文件没有 routes → 空表，不是 null");
    assertFalse(Scheme.exportScheme(w3.layout()).contains("\"routes\""), "再导出也不许冒出空 routes");
  }

  @Test
  @DisplayName("stateOf 白名单：routes 在 items 之后；每条 id → name? → points；空 routes 不发射")
  void stateOfEmitsRoutes() {
    final Map<String, Object> state = Scheme.stateOf(layoutWithRoutes());
    assertEquals(List.of("w", "d", "h", "walls", "items", "routes"), new ArrayList<>(state.keySet()),
        "字段顺序也进逐字节比对：" + state.keySet());

    @SuppressWarnings("unchecked")
    final List<Object> routes = (List<Object>) state.get("routes");
    @SuppressWarnings("unchecked")
    final Map<String, Object> first = (Map<String, Object>) routes.get(0);
    @SuppressWarnings("unchecked")
    final Map<String, Object> second = (Map<String, Object>) routes.get(1);
    assertEquals(List.of("id", "name", "points"), new ArrayList<>(first.keySet()));
    assertEquals(List.of("id", "points"), new ArrayList<>(second.keySet()), "没名字就不写 name 字段");

    final Map<String, Object> empty = Scheme.stateOf(new Layout(8, 6, 3));
    assertFalse(empty.containsKey("routes"), "空 routes 不许发射（旧方案字节不被无意义改写）");
  }

  @Test
  @DisplayName("往返：routes 导出→导入→再导出逐字节一致，站点与名字原样读回")
  void roundtripIsByteStable() {
    final String a = Scheme.exportScheme(layoutWithRoutes());
    final Scheme.ImportResult r = Scheme.importScheme(a, catalog(), false);
    assertTrue(r.ok(), String.valueOf(r.error()));
    assertEquals(2, r.layout().routes.size());
    final Layout.Route first = r.layout().routes.get(0);
    assertEquals(1, first.id);
    assertEquals("主动线", first.name);
    assertEquals(3, first.points.size());
    assertEquals(1.2, first.points.get(0)[0], 1e-12);
    assertNull(r.layout().routes.get(1).name, "没名字的动线不许凭空长出一个");
    assertEquals(a, Scheme.exportScheme(r.layout()), "同代往返必须逐字节一致");
  }

  @Test
  @DisplayName("坏 routes 整份拒绝：bad-route / duplicate-route-id / too-many-routes / route-out-of-room")
  void badRoutesRejectWholeFile() {
    assertEquals("bad-route", importOf("not-an-array").error().reason());
    assertEquals("bad-route",
        importOf(List.of(route(1, null, pts(0, 0)))).error().reason(), "只有 1 个点");
    final List<Object> many = pts(0, 0);
    for (int i = 0; i < 20; i++) many.add(Json.arr(1, 1));   // 1 + 20 = 21 个点（超上限）
    assertEquals("bad-route", importOf(List.of(route(1, null, many))).error().reason(), "21 个点");
    assertEquals("bad-route", importOf(List.of(route(0, null, pts(0, 0, 1, 1)))).error().reason(), "id 不是正整数");
    assertEquals("duplicate-route-id",
        importOf(List.of(route(1, null, pts(0, 0, 1, 1)), route(1, null, pts(2, 2, 3, 3)))).error().reason());
    final List<Object> seven = new ArrayList<>();
    for (int i = 1; i <= 7; i++) seven.add(route(i, null, pts(0, 0, 1, 1)));
    assertEquals("too-many-routes", importOf(seven).error().reason());
    assertEquals("route-out-of-room",
        importOf(List.of(route(1, null, pts(0, 0, 8.5, 0)))).error().reason(), "点戳出场景右侧");
    assertEquals("route-out-of-room",
        importOf(List.of(route(1, null, pts(0, 0, 0, -0.5)))).error().reason(), "点戳出场景上方");

    // 原因要能给人看（界面按 reason 分类、按 message 说话）
    final Scheme.ImportResult bad = importOf(List.of(route(1, null, pts(0, 0))));
    assertFalse(bad.ok());
    assertTrue(bad.error().message().contains("动线"), bad.error().message());
  }

  @Test
  @DisplayName("边界与容差：6 条 / 20 点合法；8.0000001 合法、8.001 拒绝")
  void limitsAndTolerance() {
    final List<Object> six = new ArrayList<>();
    for (int i = 1; i <= 6; i++) six.add(route(i, null, pts(0, 0, 1, 1)));
    assertTrue(importOf(six).ok(), "正好 6 条");

    final List<Object> twentyPoints = new ArrayList<>();
    for (int i = 0; i < 20; i++) twentyPoints.add(Json.arr(i * 0.1, i * 0.1));
    assertTrue(importOf(List.of(route(1, null, twentyPoints))).ok(), "正好 20 点");

    assertTrue(importOf(List.of(route(1, null, pts(8.0000001, 6.0000001, 0, 0)))).ok(),
        "浮点残差 1e-7 不该让方案打不开（与外墙容差同一条纪律）");
    assertEquals("route-out-of-room",
        importOf(List.of(route(1, null, pts(8.001, 0, 0, 0)))).error().reason(), "容差不是无限宽");
  }

  @Test
  @DisplayName("name 是装饰性字段：非字符串/空串当没写，长名字不截断（20 字上限归写入端）")
  void nameIsDecorative() {
    final String longName = "一二三四五六七八九十一二三四五六七八九十超出二十字";
    final List<Object> routes = List.of(
        route(1, longName, pts(0, 0, 1, 1)),
        route(2, null, pts(0, 0, 1, 1)));
    final Scheme.ImportResult r = importOf(routes);
    assertTrue(r.ok(), String.valueOf(r.error()));
    assertEquals(longName, r.layout().routes.get(0).name, "长名字不截断");
    assertNull(r.layout().routes.get(1).name);

    // 非字符串 name：当没写（一个名字形状不对不该让整份方案打不开）
    final Map<String, Object> weird = new LinkedHashMap<>();
    weird.put("id", 1);
    weird.put("name", 42);
    weird.put("points", pts(0, 0, 1, 1));
    final Scheme.ImportResult w = importOf(List.of(weird));
    assertTrue(w.ok(), String.valueOf(w.error()));
    assertNull(w.layout().routes.get(0).name);
  }
}
