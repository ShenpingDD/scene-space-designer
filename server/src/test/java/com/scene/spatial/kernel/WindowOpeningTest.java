package com.scene.spatial.kernel;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * WindowOpeningTest —— W2 窗在**服务端**这一侧：写入 / 读回 / 校验 / 碰撞。
 *
 * ## 为什么必须有它（用例表**看不见**这一块，是当场变异验证抓出来的）
 *
 * 只跑 `CasesAllGreenTest` 会有两个**假绿**：
 *
 * ① **写入侧丢字段看不出来。** `scheme-roundtrip` 的判据是
 *    `exportScheme(import(export(x))) == export(x)` —— **两次导出用的是同一个写入函数**，
 *    所以「写入时把 `kind`/`sill` 整段丢掉」这件事**两边一起丢、字节照样相等**。
 *    实测：把 `Scheme.wallJson` 里那句 `if (o.isWindow())` 改成 `if (false)`，
 *    `CasesAllGreenTest` **全绿** ✗（假绿）。所以「写出去真的带了这两个字段」必须由
 *    **这一份测试**直接断言 map 的键与值。
 *    （`CasesAllGreenTest` 自己的类注释记着 W1 那次同一个坑：把 `stateOf` 改成不发射门洞，
 *    预期变红，结果全绿 —— 同一个病，换了批人又犯一次。）
 *
 * ② **窗不能走人。** 用例表里有 `collision-window-blocks` 钉着，但那只覆盖
 *    `Openings.solidSegments` 的一半；这里把「只有窗的墙 = 整段一条」也钉住。
 *
 * 每条判据都写清**变异点**（怎么改代码会让它变红）。
 */
class WindowOpeningTest {

  /** 内墙在墙列表里的下标（与用例表里的夹具同形：4 面外墙在前，内墙第 5 面） */
  private static final int INNER = 4;

  /** 8×6 的房间 + 一面**带窗**的内墙 (4,0.5)→(4,5.5)，窗 at=2.5 → 世界坐标 z=3.0 */
  private static Layout layoutWithInner() {
    final Layout l = new Layout(8, 6, 2.8);
    for (final Wall bw : Wall.boundaryWalls(8, 6)) l.walls.add(bw);
    l.walls.add(wallWithWindow());
    return l;
  }

  private static Wall wallWithWindow() {
    final Wall w = Wall.of(4, 0.5, 4, 5.5);
    final List<Wall.Opening> list = new ArrayList<>();
    list.add(new Wall.Opening(2.5, 1.2, 1.5, Wall.WINDOW, 0.9));
    return w.withOpenings(list);
  }

  private static Wall wallWithDoor() {
    final Wall w = Wall.of(4, 0.5, 4, 5.5);
    final List<Wall.Opening> list = new ArrayList<>();
    list.add(new Wall.Opening(2.5, 0.9, 2.1));
    return w.withOpenings(list);
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> firstOpeningOf(Wall w) {
    final List<Object> ops = (List<Object>) Scheme.wallJson(w).get("openings");
    return (Map<String, Object>) ops.get(0);
  }

  /* ---------------- 写入侧：这两个字段必须真的写出去 ---------------- */

  @Test
  @DisplayName("wallJson：窗写出 at/w/h/kind/sill（**顺序也是逐字节比对的一部分**）；门一个字段都不多")
  void wallJsonCarriesKindAndSill() {
    final Map<String, Object> win = firstOpeningOf(wallWithWindow());
    // 变异点：`Scheme.wallJson` 里那个 `if (o.isWindow())` 改 false → 这里立刻红（用例表**抓不到**）
    assertEquals(List.of("at", "w", "h", "kind", "sill"), new ArrayList<>(win.keySet()),
        "键顺序也要与 JS `wall.js mkOpening()` 一致：" + win);
    assertEquals(Wall.WINDOW, win.get("kind"));
    assertEquals(0.9, ((Number) win.get("sill")).doubleValue(), 1e-9);

    final Map<String, Object> door = firstOpeningOf(wallWithDoor());
    assertEquals(List.of("at", "w", "h"), new ArrayList<>(door.keySet()),
        "门一个字段都不许多（老方案的字节逐字不变）：" + door);
  }

  @Test
  @DisplayName("导出文本里真的有 kind/sill；新标识 + 完整的历史兼容清单")
  void exportedTextCarriesThem() {
    final String text = Scheme.exportScheme(layoutWithInner());
    // 变异点同上：写入侧丢掉 kind/sill 时，这一条是**唯一**会红的地方
    assertTrue(text.contains("\"kind\": \"window\""), text);
    assertTrue(text.contains("\"sill\": 0.9"), text);
    assertEquals("scene-space-designer-scene-routes-columns", Scheme.FORMAT);
    // ⚠️ 换代之后的完整历史清单：旧标识一个都不能删（老文件照样打开）
    for (final String f : List.of("scene-space-designer-scene-routes-columns", "scene-space-designer-scene-routes", "scene-space-designer-scene", "scene-space-designer-windows", "scene-space-designer-openings",
        "scene-space-designer", "legacy-spatial-v2", "legacy-spatial-v3",
        "legacy-spatial-doors-v4")) {
      assertTrue(Scheme.ACCEPTED_FORMATS.contains(f), f + " 必须仍在兼容清单里");
    }
  }

  @Test
  @DisplayName("读回：窗还是窗（kind/sill 都在）")
  void importKeepsKindAndSill() {
    final Scheme.ImportResult r = Scheme.importScheme(Scheme.exportScheme(layoutWithInner()), null, false);
    assertTrue(r.ok(), String.valueOf(r.error()));
    final Wall.Opening o = r.layout().walls.get(INNER).openings.get(0);
    // 变异点：`Scheme` 读那一侧不读 kind/sill → 这里变门，立刻红
    assertTrue(o.isWindow(), String.valueOf(o));
    assertEquals(0.9, o.sill(), 1e-9);
  }

  @Test
  @DisplayName("旧文件（只有门、旧标识）照旧能导入，读出来就是门 —— 兼容是功能，不是包袱")
  void legacyFileStillOpens() {
    final String legacy = "{\"format\":\"scene-space-designer-openings\",\"state\":{\"w\":8,\"d\":6,\"h\":2.8,"
        + "\"walls\":[{\"a\":[0,0],\"b\":[8,0],\"openings\":[{\"at\":4,\"w\":1.2,\"h\":2.1}]}],\"items\":[]}}";
    final Scheme.ImportResult r = Scheme.importScheme(legacy, null, false);
    assertTrue(r.ok(), String.valueOf(r.error()));
    final Wall.Opening o = r.layout().walls.get(0).openings.get(0);
    assertEquals("door", Wall.kindOf(o), "没有 kind 就是门");
    assertEquals(0, Wall.sillOf(o), 1e-9);
  }

  /* ---------------- 形状与语义 ---------------- */

  @Test
  @DisplayName("kindOf/sillOf：缺省即门、认不得的 kind 也当门；门恒 0")
  void kindAndSillDefaults() {
    assertEquals("door", Wall.kindOf(new Wall.Opening(1, 1, 1)));
    assertEquals("door", Wall.kindOf(new Wall.Opening(1, 1, 1, "skylight", 1.1)),
        "认不得的 kind 一律当门（不报错、不猜、不回就近值）");
    assertEquals(Wall.WINDOW, Wall.kindOf(new Wall.Opening(1, 1, 1, Wall.WINDOW, 1.1)));
    assertEquals(0, Wall.sillOf(new Wall.Opening(1, 1, 1)), 1e-9);
    assertEquals(0, Wall.sillOf(new Wall.Opening(1, 1, 1, Wall.WINDOW, -0.5)), 1e-9);
    assertEquals(1.1, Wall.sillOf(new Wall.Opening(1, 1, 1, Wall.WINDOW, 1.1)), 1e-9);
  }

  @Test
  @DisplayName("⭐ 窗**不能走人**：只有窗的墙 = 整段一条；只有门的墙 = 两条（成对）")
  void windowDoesNotCutTheWall() {
    final List<double[]> segs = Openings.solidSegments(wallWithWindow());
    // 变异点：`Openings.solidSegments` 用 `spans()` 而不是 `doorSpans()` → 这里变 2 条，立刻红
    assertEquals(1, segs.size(), String.valueOf(segs.size()));
    assertEquals(4, segs.get(0)[0], 1e-9);
    assertEquals(0.5, segs.get(0)[1], 1e-9);
    assertEquals(4, segs.get(0)[2], 1e-9);
    assertEquals(5.5, segs.get(0)[3], 1e-9);

    assertEquals(2, Openings.solidSegments(wallWithDoor()).size(),
        "成对的另一半：门洞那儿是真的断开了");
  }

  /* ---------------- 校验 ---------------- */

  @Test
  @DisplayName("结构：离地不是有限数 / 负数 → BAD_SILL；离地 + 净高 > 墙高 → TOO_TALL；恰好贴顶合法")
  void structuralChecks() {
    final Wall w = Wall.of(4, 0.5, 4, 5.5);
    assertEquals(Openings.BAD_SILL,
        Openings.structuralProblem(w, new Wall.Opening(2.5, 1.2, 1.5, Wall.WINDOW, Double.NaN), 2.8).reason());
    assertEquals(Openings.BAD_SILL,
        Openings.structuralProblem(w, new Wall.Opening(2.5, 1.2, 1.5, Wall.WINDOW, -0.1), 2.8).reason());
    assertEquals(Openings.TOO_TALL,
        Openings.structuralProblem(w, new Wall.Opening(2.5, 1.2, 1.5, Wall.WINDOW, 1.5), 2.8).reason());
    assertNull(Openings.structuralProblem(w, new Wall.Opening(2.5, 1.2, 1.5, Wall.WINDOW, 1.3), 2.8),
        "1.3 + 1.5 = 2.8 恰好贴顶 → 合法");
    // 门不受离地约束（老用例一条都不许变）
    assertNull(Openings.structuralProblem(w, new Wall.Opening(2.5, 0.9, 2.1), 2.8));
    // 每墙上限**按类别各算各的**：窗的条数用 `windowMaxPerWall`，与门洞互不影响
    assertTrue(ParamsLive.p().windowMaxPerWall > 0);
  }
}