package com.scene.spatial.kernel;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * WallBoundsTest —— B19：墙也要跟房间比（Java 侧）。
 *
 * 与 `spatial-core/test/wall-bounds.test.js` 是**同一条规则的两份实现**，所以这里逐条对着写：
 *   ① 贴边合法（外墙正好压着边界 —— 判据对它们是"恰好合法"）；
 *   ② 探出去必须报 `wall-out-of-room`，并给出**序号**；
 *   ③ **正常文件照样能导入**（只做 ② 很危险：把判据写严一点就能让所有文件都进不来，而测试是绿的）。
 *
 * ⚠️ 这份测试第一版是"猜着 API 写"的（`Scheme.read` / `Json.text` / `Catalog::empty` 全是我编的）。
 * 自建数据的字段形状不许猜 —— 现在改成都用真 API：`Scheme.importScheme` / `Scheme.stateOf` / `Json.write`。
 */
class WallBoundsTest {

  private static Catalog catalog() {
    return new Catalog(Cases.CATALOG);
  }

  /** 8×6 的房间：四面外墙 + 一面内墙 (2,2)-(2,5) */
  private static Layout room() {
    final Layout l = new Layout(8, 6, 2.8);
    l.walls.add(Wall.of(0, 0, 8, 0));
    l.walls.add(Wall.of(8, 0, 8, 6));
    l.walls.add(Wall.of(8, 6, 0, 6));
    l.walls.add(Wall.of(0, 6, 0, 0));
    l.walls.add(Wall.of(2, 2, 2, 5));
    return l;
  }

  /** 用**真写入端**造方案文件（不是手拼字符串 —— 手拼的 JSON 测不出写入端自己的毛病） */
  private static String fileOf(Layout l) {
    // 用**真写入端**造新格式文件（`Scheme.FORMAT` 而不是手写字符串：标识一直由内核说了算）
    return Json.write(Json.obj("format", Scheme.FORMAT, "state", Scheme.stateOf(l)), 0);
  }

  @Test
  void 贴边合法_外墙与贴边内墙都不算越界() {
    final Layout l = room();
    assertNull(Validate.checkWall(l, Wall.of(0, 0, 8, 0)), "外墙就是边界本身，跳过");
    assertNull(Validate.checkWall(l, Wall.of(2, 2, 2, 5)), "屋里的内墙");
    assertNull(Validate.checkWall(l, Wall.of(0, 1, 0, 4)), "内墙贴着边界也合法（x=0 是范围之内）");
    assertTrue(Validate.badWalls(l).isEmpty(), "整间房干净");
  }

  @Test
  void 探出去的墙要报序号() {
    final Layout l = room();
    l.walls.add(Wall.of(9, 1, 9, 4));    // x=9 > w=8
    l.walls.add(Wall.of(1, -2, 4, -2));  // z=-2 < 0
    final int[][] bad = Validate.badWalls(l).toArray(new int[0][]);
    assertEquals(2, bad.length);
    assertEquals(5, bad[0][0]);
    assertEquals(6, bad[1][0]);
    assertEquals(Validate.WALL_OUT_OF_ROOM, Validate.checkWall(l, l.walls.get(5)));
  }

  @Test
  void 越界墙会把体检结论从_clean_上拉下来() {
    final Layout l = room();
    l.items.add(new Layout.Item(1, "demo-cabinet-800", 0.7, 0.7, 0, 0));
    final Audit.Report ok = Audit.of(l, catalog());
    assertTrue(ok.clean(), "干净的房间：设备放得下、墙也在屋里");
    assertEquals(0, ok.wallIssues());

    l.walls.add(Wall.of(9, 1, 9, 4));
    final Audit.Report bad = Audit.of(l, catalog());
    assertEquals(0, bad.issues(), "台数没变 —— 台数与墙数是两种东西，不许混着算");
    assertEquals(1, bad.wallIssues());
    assertTrue(!bad.clean(), "墙摆得不对，报告就不能说 clean");
    assertEquals(1, bad.wallRows().size());
    assertEquals(5, bad.wallRows().get(0).index());
    assertEquals(Validate.WALL_OUT_OF_ROOM, bad.wallRows().get(0).reason());
  }

  @Test
  void 正常文件照样能导入_越界墙被拒() {
    final Scheme.ImportResult r1 = Scheme.importScheme(fileOf(room()), catalog(), false);
    assertTrue(r1.ok(), "正常文件（含四面贴边外墙）必须能导入 —— 判据不许把边界当越界");
    assertEquals(5, r1.layout().walls.size());

    final Layout l = room();
    l.walls.add(Wall.of(9, 1, 9, 4));
    final Scheme.ImportResult r2 = Scheme.importScheme(fileOf(l), catalog(), false);
    assertTrue(!r2.ok());
    assertNotNull(r2.error());
    assertEquals("wall-out-of-room", r2.error().reason());
    assertEquals("无法导入：有墙体落在空间之外", r2.error().message());
  }
}