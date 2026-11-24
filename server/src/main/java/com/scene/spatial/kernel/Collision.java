package com.scene.spatial.kernel;

import java.util.ArrayList;
import java.util.List;

/**
 * Collision.java —— 规则 4 的通行部分：漫游碰撞与移动
 *
 * 移植自 `spatial-core/src/collision.js`（原型 `02_walkthrough.js` 的 `blocked()` / `safeSpawn()`）。
 * 坐标一律是**房间本地坐标**（0..w / 0..d），与墙、设备同一坐标系 ——
 * 原型靠 `colliders()` 里手动 translate(w/2, 0, d/2) 转换，这里不引入 Three.js，直接约定。
 *
 * ⚠️ 两处**已知缺陷在此保持行为对齐**（与 JS 一样，用断言钉住，不悄悄改行为）：
 *   - **FIX-16**：门用世界 AABB 表达，开门后 AABB 覆盖整个扫掠区 → 空地上凭空出现隐形障碍；
 *                且未跳过 `amount === 0` 的门。
 *   - **FIX-17**：玩家一旦被几何体嵌入，`blocked()` 恒为 true，而移动只做"拒绝" → 永久卡死。
 *   修的时候必须**显式改掉这些判据**（连同用例表），而不是悄悄改行为。
 */
public final class Collision {

  private Collision() {
  }

  /** 门在房间本地坐标下的包围盒（渲染层从铰链节点的网格算出后传入） */
  public record DoorBox(double minX, double minZ, double maxX, double maxZ, double minY, double maxY) {
  }

  /** 门障碍是否真挡住人（原型只按高度区间判断） */
  public static boolean doorIsBlocking(DoorBox box) {
    return box.minY() < ParamsLive.p().walkDoorBarrierMaxM && box.maxY() > ParamsLive.p().walkDoorBarrierMinM;
  }

  /** 该点能否站人（返回 true = 被挡）—— 原型 `blocked()` */
  public static boolean blocked(double x, double z, Layout layout, Catalog catalog,
                                List<DoorBox> doorBoxes, double radius) {
    // ① 房间边界内缩 radius
    if (x < radius || z < radius || x > layout.w - radius || z > layout.d - radius) return true;

    // ② 墙（含外墙；配合 ① 的有效安全距离因此是 radius + wallClearance）
    //    ⭐ W1 门洞：墙不是一整段了 —— 有洞的地方是**实心子段**之间的缺口。
    //    不写"整墙判定 + 洞区间 if-else 放行"：那样 0.1 m 的缝也能钻过去；子段喂给同一个
    //    距离函数才是对的几何（窄洞自然过不去）。与 JS `collision.js` 同算式。
    for (final Wall w : layout.walls) {
      for (final double[] seg : Openings.solidSegments(w)) {
        if (Geometry.segmentDistance(x, z, seg[0], seg[1], seg[2], seg[3])
            < radius + ParamsLive.p().walkWallClearanceM) return true;
      }
    }

    // ③ 设备：把点变换到设备本地系，算到占地矩形的距离（等价于圆-矩形相交）
    for (final Layout.Item i : layout.items) {
      final double[] p = catalog.footprint(i.p);
      if (p == null) continue;
      final double a = i.r * Geometry.DEG;
      final double dx = x - i.x;
      final double dz = z - i.z;
      final double lx = Math.cos(a) * dx + Math.sin(a) * dz;
      final double lz = -Math.sin(a) * dx + Math.cos(a) * dz;
      final double qx = Math.max(Math.abs(lx) - p[0] / 2, 0);
      final double qz = Math.max(Math.abs(lz) - p[1] / 2, 0);
      if (Math.hypot(qx, qz) < radius) return true;
    }

    // ④ 开着的门（原型口径：AABB + 高度区间 —— FIX-16 的缺陷在此保持对齐）
    for (final DoorBox b : doorBoxes) {
      if (doorIsBlocking(b)
          && x > b.minX() - radius && x < b.maxX() + radius
          && z > b.minZ() - radius && z < b.maxZ() + radius) return true;
    }
    return false;
  }

  /** 没有门包围盒时的便捷重载（判据不变：门是可选输入） */
  public static boolean blocked(double x, double z, Layout layout, Catalog catalog) {
    return blocked(x, z, layout, catalog, List.of(), ParamsLive.p().walkRadiusM);
  }

  /** 玩家当前是否已被几何体嵌入（FIX-17 的判定入口；恒 true 时原型会永久卡死） */
  public static boolean isStuck(double x, double z, Layout layout, Catalog catalog, List<DoorBox> doorBoxes) {
    return blocked(x, z, layout, catalog, doorBoxes, ParamsLive.p().walkRadiusM);
  }

  /** 找一个能站人的出生点（原型 `safeSpawn`：先试房间中央两处，再 0.35 m 网格扫）。返回 null = 无处可站 */
  public static double[] safeSpawn(Layout layout, Catalog catalog, List<DoorBox> doorBoxes) {
    final List<double[]> candidates = new ArrayList<>();
    candidates.add(new double[]{layout.w / 2, layout.d * 0.75});
    candidates.add(new double[]{layout.w / 2, layout.d / 2});
    for (double z = 0.4; z < layout.d; z += ParamsLive.p().walkSpawnStepM) {
      for (double x = 0.4; x < layout.w; x += ParamsLive.p().walkSpawnStepM) candidates.add(new double[]{x, z});
    }
    for (final double[] c : candidates) {
      if (!blocked(c[0], c[1], layout, catalog, doorBoxes, ParamsLive.p().walkRadiusM)) return c;
    }
    return null;
  }
}