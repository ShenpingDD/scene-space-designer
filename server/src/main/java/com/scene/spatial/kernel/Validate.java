package com.scene.spatial.kernel;

import java.util.ArrayList;
import java.util.List;

/**
 * Validate.java —— 规则 1：这台设备摆在这个位置合法吗
 *
 * 移植自 `spatial-core/src/validate.js`（含 R1 的 FIX-04：外墙不再是障碍物）。
 *
 * 这是全项目最核心的一条规则：原型里 2D 面板校验、漫游碰撞、导入校验**各写了一份且互相打架**；
 * R2 起只有这一份，前端与服务端都调它。所以 Java 这一份必须与 JS **逐条同结论**
 * （用例表 `validate-*` 四条就是这条的验收：合法 / 越界 / 压内墙 / 与 #1 重叠）。
 */
public final class Validate {

  private Validate() {}

  public static final String UNKNOWN_PRODUCT = "unknown-product";
  public static final String OUT_OF_ROOM = "out-of-room";
  public static final String OVERLAP_ITEM = "overlap-item";
  public static final String HIT_WALL = "hit-wall";
  /** W5 柱：设备压柱（设计决策记录；与 JS `columns.js` 的 `hit-column#id` 一字不差） */
  public static final String HIT_COLUMN = "hit-column";
  /** 墙的原因码（B19）—— 与 JS `WALL_REASON` 一字不差 */
  public static final String WALL_OUT_OF_ROOM = "wall-out-of-room";

  /**
   * 单台设备的合法性检查。
   *
   * @return null = 合法；否则原因码（重叠会带 `#<对方id>`，供 UI 精准提示）
   */
  public static String checkItem(Layout layout, Layout.Item item, Catalog catalog) {
    final double[] p = catalog.footprint(item.p);
    if (p == null) return UNKNOWN_PRODUCT;

    final double[][] a = Geometry.corners(item.x, item.z, p[0], p[1], item.r);

    // ① 四角必须都在房间内：越界由这条兜住，外墙因此无需再当障碍物（FIX-04）
    for (final double[] c : a) {
      if (c[0] < 0 || c[0] > layout.w || c[1] < 0 || c[1] > layout.d) return OUT_OF_ROOM;
    }

    // ② 与其它设备重叠（标准品按占地矩形做 OBB 相交）
    for (final Layout.Item j : layout.items) {
      if (j.id == item.id) continue;
      final double[] q = catalog.footprint(j.p);
      if (q == null) continue;
      if (Geometry.overlap(a, Geometry.corners(j.x, j.z, q[0], q[1], j.r))) return OVERLAP_ITEM + "#" + j.id;
    }

    // ③ 碰内墙（外墙跳过：它是房间边界，不是障碍物 —— FIX-04）
    //    注意：门洞**不影响这条** —— 设备压在门洞那块地方照样算碰墙（门口不是停车位），
    //    所以这里用的仍是整段墙的矩形（需要"洞处不挡"的是漫游/开门净空，见 Collision/Clearance）。
    for (final Wall wall : layout.walls) {
      if (Room.isBoundaryWall(layout, wall)) continue;
      if (Geometry.overlap(a, Geometry.wallBox(wall))) return HIT_WALL;
    }

    // ④ 压柱（W5）：柱是第四类实心障碍，放在碰内墙之后 —— 旧原因码的优先级不许变
    //    （同一台设备既碰墙又压柱时，仍先报 hit-wall；界面文案与历史用例都按这个顺序）。
    //    柱是轴对齐矩形：`corners(x,z,w,d,0)` 就是它的四个角，与设备 OBB 用同一套相交判据。
    for (final Layout.Column column : layout.columns) {
      if (Geometry.overlap(a, Geometry.corners(column.x, column.z, column.w, column.d, 0))) {
        return HIT_COLUMN + "#" + column.id;
      }
    }

    return null;
  }

  /**
   * 一面墙的合法性：**两个端点都必须落在场景范围内**（B19）。
   *
   * 与 JS `validate.checkWall()` **同一条判据、同一个容差**（W3 起对齐；此前 Java 这边
   * 对"外墙"是**整条跳过**，于是"贴着外墙那条线、但一头戳出去"的墙会被判合法 ——
   * 而 JS 写端与读端调的是同一个带容差的函数。两边结论不一致时，**保存能过、导入却拒绝**
   * 正是 FIX-05 的形状：写读两套规则。用例 `wall-exterior-tolerance-*` 就是钉这一条的）。
   *
   * 容差只有一个区别：
   *  · 外墙（`Room.wallRole` = `exterior`）的坐标本来就**恰好**是 0 / w / d，
   *    浮点会让它差 1e-16 → 给 `1e-6` 容差；
   *  · 内墙不留容差：贴边合法，探出去不合法。
   *
   * 角色优先的含义：一面**标了** `exterior` 但落在场景中间的墙，也按外墙容差判 ——
   * 判据只看"它自称是什么"，几何只给没标注的墙兜底（与 JS 同口径）。
   *
   * @return null = 合法；否则 {@link #WALL_OUT_OF_ROOM}
   */
  public static String checkWall(Layout layout, Wall wall) {
    final double tol = Room.isBoundaryWall(layout, wall) ? 1e-6 : 0;
    final boolean out = wall.a[0] < -tol || wall.a[0] > layout.w + tol
        || wall.a[1] < -tol || wall.a[1] > layout.d + tol
        || wall.b[0] < -tol || wall.b[0] > layout.w + tol
        || wall.b[1] < -tol || wall.b[1] > layout.d + tol;
    return out ? WALL_OUT_OF_ROOM : null;
  }

  /** 全量墙体检：返回墙**序号**清单（墙没有 id，与 2D 的 data-wall-index 同一套编号） */
  public static List<int[]> badWalls(Layout layout) {
    final List<int[]> out = new ArrayList<>();
    for (int i = 0; i < layout.walls.size(); i++) {
      if (checkWall(layout, layout.walls.get(i)) != null) out.add(new int[]{i});
    }
    return out;
  }

  /** 是否合法 */
  public static boolean isValid(Layout layout, Layout.Item item, Catalog catalog) {
    return checkItem(layout, item, catalog) == null;
  }

  /** 全量体检（返回非法设备数 + 首条原因，报告用） */
  public static int[] audit(Layout layout, Catalog catalog) {
    int bad = 0;
    for (final Layout.Item it : layout.items) {
      if (checkItem(layout, it, catalog) != null) bad++;
    }
    return new int[]{bad, layout.items.size()};
  }
}