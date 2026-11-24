package com.scene.spatial.kernel;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * WallRoleTest —— W3 开放场景：角色（`exterior` / `interior`）在 Java 侧的全部判据。
 *
 * 与 `spatial-core/test/wall-role.test.js` / `scheme.test.js` 是**同一条规则的两份实现**，
 * 所以这里逐条对着写（docs/93 §7.1 的 Java 镜像清单）：
 *
 *   ① `stateOf` 的字段白名单**必须发射 `role`** —— 漏一个字段就重演 FIX-05：
 *      角色在「保存 → 分享 → 交付」链上无警告消失，用户下次打开时墙的语义已经变了；
 *   ② 字段顺序固定 `a, b, openings?, role?`（顺序也是逐字节比对的一部分，Java 与 JS 都靠它）；
 *   ③ 旧标识导入后 `roomSemantics = legacy`（旧方案房间数不许变），新标识 = `walls`；
 *   ④ 认不得的 `role` **当没写**（不拒整份文件 —— 未来多一个角色不该让昨天的方案打不开）；
 *   ⑤ `checkWall` 与 JS 同口径：外墙 1e-6 容差、内墙 0，**不再整条跳过**。
 */
class WallRoleTest {

  private static Catalog catalog() {
    return new Catalog(Cases.CATALOG);
  }

  /** 8×6：四面外墙（标 exterior）+ 一面内墙（标 interior） */
  private static Layout layout() {
    final Layout l = new Layout(8, 6, 2.8);
    l.walls.add(Wall.of(0, 0, 8, 0).withRole(Wall.EXTERIOR));
    l.walls.add(Wall.of(8, 0, 8, 6).withRole(Wall.EXTERIOR));
    l.walls.add(Wall.of(8, 6, 0, 6).withRole(Wall.EXTERIOR));
    l.walls.add(Wall.of(0, 6, 0, 0).withRole(Wall.EXTERIOR));
    l.walls.add(Wall.of(2, 2, 2, 5).withRole(Wall.INTERIOR));
    return l;
  }

  private static List<Object> wallsOf(Map<String, Object> state) {
    @SuppressWarnings("unchecked")
    final List<Object> walls = (List<Object>) state.get("walls");
    return walls;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> firstWall(Map<String, Object> state) {
    return (Map<String, Object>) wallsOf(state).get(0);
  }

  @Test
  @DisplayName("stateOf 发射 role：字段顺序 a, b, role（有洞口时 role 在 openings 之后）")
  void stateOfEmitsRoleInStableOrder() {
    final Map<String, Object> state = Scheme.stateOf(layout());
    final Map<String, Object> first = firstWall(state);
    assertEquals(List.of("a", "b", "role"), new ArrayList<>(first.keySet()),
        "没有洞口的墙：role 紧跟在 b 之后：" + first);
    assertEquals("exterior", first.get("role"), "角色原样发射");

    // 带洞口的墙：role 必须在 openings **之后**（顺序也进逐字节比对）
    final Layout withDoor = new Layout(8, 6, 2.8);
    final Wall door = Wall.of(0, 0, 8, 0).withRole(Wall.EXTERIOR)
        .withOpenings(List.of(new Wall.Opening(2, 0.9, 2.1)));
    withDoor.walls.add(door);
    final Map<String, Object> withOpening = firstWall(Scheme.stateOf(withDoor));
    assertEquals(List.of("a", "b", "openings", "role"), new ArrayList<>(withOpening.keySet()),
        "有洞口的墙：openings 在前、role 在后：" + withOpening);

    // 没有角色 = 不写这个字段（旧墙导出字节必须逐字不变）
    final Layout plain = new Layout(8, 6, 2.8);
    plain.walls.add(Wall.of(2, 2, 2, 5));
    assertEquals(List.of("a", "b"), new ArrayList<>(firstWall(Scheme.stateOf(plain)).keySet()),
        "没标注角色就不许发射 role（否则老方案导出字节会变）");
  }

  @Test
  @DisplayName("⭐ 往返：role 在 导出→导入→再导出 里一个都不许丢，且逐字节一致")
  void roleSurvivesRoundtrip() {
    final Layout l = layout();
    final String a = Scheme.exportScheme(l);
    final Scheme.ImportResult r = Scheme.importScheme(a, catalog(), false);
    assertTrue(r.ok(), String.valueOf(r.error()));
    assertEquals("exterior", r.layout().walls.get(0).role, "导入读回了角色");
    assertEquals("interior", r.layout().walls.get(4).role, "内墙的角色也在");
    final String b = Scheme.exportScheme(r.layout());
    assertEquals(a, b, "同代往返必须逐字节一致（顺序也算）：" + b);
  }

  @Test
  @DisplayName("认不得的 role 当没写：导入不拒、导出不写（未来多一个角色不该让老文件打不开）")
  void unknownRoleIsIgnored() {
    final String file = Json.write(Json.obj(
        "format", Scheme.FORMAT,
        "state", Json.obj(
            "w", 8, "d", 6, "h", 2.8,
            "walls", List.of(Json.obj("a", Json.arr(0, 0), "b", Json.arr(8, 0), "role", "fence")),
            "items", List.of())), 0);
    final Scheme.ImportResult r = Scheme.importScheme(file, catalog(), false);
    assertTrue(r.ok(), "一个认不得的角色不许拒掉整份文件：" + r.error());
    assertNull(r.layout().walls.get(0).role, "认不得的值当作没写");
    assertFalse(Scheme.exportScheme(r.layout()).contains("fence"), "再导出时也不许把它写回去");
  }

  @Test
  @DisplayName("格式标识换代：新标识 walls 语义、旧标识 legacy 语义（旧方案房间数不许变）")
  void formatDrivesRoomSemantics() {
    assertEquals("scene-space-designer-scene-routes-columns", Scheme.FORMAT);

    final Scheme.ImportResult now = Scheme.importScheme(Scheme.exportScheme(layout()), catalog(), false);
    assertTrue(now.ok());
    assertEquals("walls", now.roomSemantics(), "新标识 → walls");
    assertEquals("walls", now.layout().roomSemantics, "layout 上也挂着同一条语义");

    // W3（开放场景）是只读历史，但**语义仍是 walls**：它正是开放场景口径的起点，
    // 退回 legacy 会把院子算回房间、开放面积变 0（docs/97 §四点名的坑）。
    final Scheme.ImportResult w3 = Scheme.importScheme(
        Json.write(Json.obj("format", "scene-space-designer-scene", "state", Json.obj(
            "w", 8, "d", 6, "h", 2.8,
            "walls", List.of(Json.obj("a", Json.arr(0, 0), "b", Json.arr(8, 0))),
            "items", List.of())), 0), catalog(), false);
    assertTrue(w3.ok(), String.valueOf(w3.error()));
    assertEquals("walls", w3.roomSemantics(), "W3 标识 → walls（不许退回 legacy）");

    for (final String legacy : List.of("scene-space-designer-windows", "scene-space-designer-openings",
        "scene-space-designer", "legacy-spatial-v2", "legacy-spatial-v3",
        "legacy-spatial-doors-v4")) {
      assertTrue(Scheme.ACCEPTED_FORMATS.contains(legacy), legacy + " 必须仍在兼容清单里");
      final Scheme.ImportResult r = Scheme.importScheme(
          Json.write(Json.obj("format", legacy, "state", Json.obj(
              "w", 8, "d", 6, "h", 2.8,
              "walls", List.of(Json.obj("a", Json.arr(0, 0), "b", Json.arr(8, 0))),
              "items", List.of())), 0), catalog(), false);
      assertTrue(r.ok(), legacy + " 应可导入：" + r.error());
      assertEquals("legacy", r.roomSemantics(), legacy + " → legacy（旧语义）");
      assertEquals(legacy, r.format(), "导入结果如实带回原标识");
    }
  }

  @Test
  @DisplayName("roomSemantics 不进 state：stateOf 只有 w/d/h/walls/items（+ 可选 view/roomLabels）")
  void semanticsIsNotData() {
    final Map<String, Object> state = Scheme.stateOf(layout());
    assertFalse(state.containsKey("roomSemantics"), "派生口径不是数据：" + state.keySet());
    assertFalse(Scheme.exportScheme(layout()).contains("roomSemantics"));
    assertFalse(Scheme.exportScheme(layout()).contains("openArea"));
  }

  @Test
  @DisplayName("角色优先、几何回退：标了 interior 的贴边墙是内墙，标了 exterior 的中间墙是外墙")
  void roleWinsOverGeometry() {
    final Layout l = new Layout(8, 6, 2.8);
    final Wall edgeButInterior = Wall.of(0, 0, 0, 6).withRole(Wall.INTERIOR);
    final Wall middleButExterior = Wall.of(2, 3, 6, 3).withRole(Wall.EXTERIOR);
    l.walls.add(edgeButInterior);
    l.walls.add(middleButExterior);
    assertEquals(Wall.INTERIOR, Room.wallRole(l, edgeButInterior), "标了内墙就按内墙（即使贴着边）");
    assertEquals(Wall.EXTERIOR, Room.wallRole(l, middleButExterior), "标了外墙就按外墙（即使在中间）");
    assertFalse(Room.isBoundaryWall(l, edgeButInterior));
    assertTrue(Room.isBoundaryWall(l, middleButExterior));

    // 没标注 → 几何回退：贴边算外墙、屋里算内墙（旧文件的口径）
    final Wall noRole = Wall.of(8, 0, 8, 6);
    final Wall inner = Wall.of(2, 2, 2, 5);
    assertEquals(Wall.EXTERIOR, Room.wallRole(l, noRole));
    assertEquals(Wall.INTERIOR, Room.wallRole(l, inner));
  }

  @Test
  @DisplayName("⭐ checkWall 与 JS 同口径：外墙 1e-6 容差、不许整条跳过")
  void checkWallMatchesJsTolerance() {
    final Layout l = new Layout(8, 6, 2.8);

    // ① 贴边外墙：坐标恰好是 0/w —— 合法
    assertNull(Validate.checkWall(l, Wall.of(0, 0, 8, 0).withRole(Wall.EXTERIOR)));

    // ② 贴边外墙带浮点残差（1e-7）：JS 给 1e-6 容差，这里必须同结论
    assertNull(Validate.checkWall(l, Wall.of(0, 0, 8 + 1e-7, 0).withRole(Wall.EXTERIOR)),
        "浮点残差 1e-7 在外墙容差内");

    // ③ 一端探出 0.5 m：**必须报** —— 旧 Java 越过这一条（外墙整条跳过 → 判成合法）
    assertEquals(Validate.WALL_OUT_OF_ROOM,
        Validate.checkWall(l, Wall.of(0, 0, 8.5, 0).withRole(Wall.EXTERIOR)),
        "外墙探出去半个边界也必须报（这是与 JS 对齐的那一条）");

    // ④ 内墙不留容差：贴边恰好合法、探出 1e-7 也报
    assertNull(Validate.checkWall(l, Wall.of(0, 1, 0, 4).withRole(Wall.INTERIOR)));
    assertEquals(Validate.WALL_OUT_OF_ROOM,
        Validate.checkWall(l, Wall.of(0, 1, -1e-7, 4).withRole(Wall.INTERIOR)),
        "内墙没有容差：探出去一点点也算越界");
  }

  @Test
  @DisplayName("checkItem 也按角色判：标了 exterior 的中间墙**不挡设备**，没标注的中间墙照挡")
  void interiorWallBlockingIsRoleAware() {
    final Layout l = new Layout(8, 6, 2.8);
    final Wall middle = Wall.of(4, 2, 4, 5);
    l.walls.add(middle);
    final Layout.Item item = new Layout.Item(1, "demo-cabinet-800", 4, 3.5, 0, 0);

    // 没标注 → 几何回退成内墙 → 挡（旧行为的正确部分）
    assertEquals(Validate.HIT_WALL, Validate.checkItem(l, item, catalog()),
        "中间那面墙没标注时就是内墙，设备压上去要挡");

    // 标成外墙 → 不挡（角色优先；否则「一面标了外墙的墙」会同时被当障碍物，界面与保存各说一套）
    middle.role = Wall.EXTERIOR;
    assertNull(Validate.checkItem(l, item, catalog()),
        "标了 exterior 的墙不是障碍物（FIX-04 的语义由角色接管）");
  }

  @Test
  @DisplayName("复制/换洞口/改尺寸都不许把角色弄丢（丢了就是编辑后语义静默变了）")
  void roleSurvivesCopyAndResize() {
    final Wall w = Wall.of(2, 2, 2, 5).withRole(Wall.INTERIOR);
    assertEquals(Wall.INTERIOR, w.copy().role, "深拷贝带上角色");
    assertEquals(Wall.INTERIOR, w.withOpenings(List.of(new Wall.Opening(1, 0.9, 2.1))).role,
        "换门洞带上角色");

    final Layout l = layout();
    final Room.Apply applied = Room.applyRoomSize(l, 10, 8, 2.8);
    assertTrue(applied.ok(), String.valueOf(applied.error()));
    final Wall kept = applied.layout().walls.get(applied.layout().walls.size() - 1);
    assertEquals(Wall.INTERIOR, kept.role, "改尺寸保留下来的内墙，角色跟着走：" + kept);
    assertNotNull(applied.layout().roomSemantics, "新 layout 的语义字段要有缺省值");
  }
}
