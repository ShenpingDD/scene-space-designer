package com.scene.spatial.kernel;

import java.util.ArrayList;
import java.util.List;

/**
 * Clearance.java —— 规则 7：开门净空
 *
 * 移植自 `spatial-core/src/clearance.js`。接缝 A 的 **A3** 决策：算出"实际可开角度"、
 * 分两级（黄/绿）提示、**不阻断放置** —— 因为"放得下"与"用得上"是两件事。
 *
 * 为什么单列一条规则：{@link Validate} 判的是放不放得下（越界/占地重叠/压内墙），
 * 而设计器真正要回答客户的是"这么摆能不能用" —— **门打不开的柜子等于不能用的柜子**。
 *
 * ⚠️ 扫掠分辨率必须与 JS 一致（{@link Params#doorSweepStepDeg} = 1°）：`freeDeg` 是整数度，
 *    步长不同两边数字就对不上（用例表里 106 / 62 / 20 / 19 / 0 这些数就是判据）。
 */
public final class Clearance {

  private Clearance() {}

  /**
   * 门板在**房间坐标系**下的 4 个角点。
   * ① 先绕铰链自转 openDeg（与 three.js 绕 +Y 同一约定：局部 (x,z) → (x·cosθ + z·sinθ, −x·sinθ + z·cosθ)）
   * ② 再按设备朝向转到房间（与 {@link Geometry#corners} 同方向）
   */
  public static double[][] doorPlateAt(Layout.Item item, Catalog.Door door, double openDeg) {
    final double a = openDeg * Geometry.DEG;
    final double ca = Math.cos(a);
    final double sa = Math.sin(a);
    final double R = item.r * Geometry.DEG;
    final double cr = Math.cos(R);
    final double sr = Math.sin(R);
    final double[][] leaf = {
        {door.x0(), door.z0()}, {door.x1(), door.z0()}, {door.x1(), door.z1()}, {door.x0(), door.z1()},
    };
    final double[][] out = new double[4][2];
    for (int i = 0; i < 4; i++) {
      final double dx = leaf[i][0] - door.hingeX();
      final double dz = leaf[i][1] - door.hingeZ();
      final double bx = door.hingeX() + dx * ca + dz * sa;
      final double bz = door.hingeZ() - dx * sa + dz * ca;
      out[i][0] = item.x + bx * cr - bz * sr;
      out[i][1] = item.z + bx * sr + bz * cr;
    }
    return out;
  }

  /** 门的铰链在**房间坐标系**下的位置（与 {@link #doorPlateAt} 同一套变换） */
  public static double[] doorHingeAt(Layout.Item item, Catalog.Door door) {
    final double R = item.r * Geometry.DEG;
    final double cr = Math.cos(R);
    final double sr = Math.sin(R);
    return new double[]{
        item.x + door.hingeX() * cr - door.hingeZ() * sr,
        item.z + door.hingeX() * sr + door.hingeZ() * cr,
    };
  }

  /** 门板出房间了？（外墙 = 房间边界，同一口径） */
  static boolean outOfRoom(double[][] plate, Layout room) {
    for (final double[] p : plate) {
      if (p[0] < 0 || p[1] < 0 || p[0] > room.w || p[1] > room.d) return true;
    }
    return false;
  }

  /** 挡门的家伙：`item` 带 id、`wall` 是内墙、`room` 是房间边界（外墙） */
  public record Blocker(String kind, Integer id) {
  }

  /**
   * 某个开角下门板撞到了谁。
   *
   * `nearItems` / `nearWalls` 是**粗筛**结果（null = 全量逐台测）。判据与 JS 一致：
   * 门板上每个点到铰链的距离都不超过 `swing`，所以"到铰链距离 > swing + 容差"的设备/墙
   * 无论转到哪个角度都碰不到 —— 提前剔掉。结果与全量**完全一致**，但 100 台时从 2.9 秒降到 0.14 秒。
   */
  static Blocker plateBlocker(double[][] plate, Layout layout, int selfId, Catalog catalog,
                              List<Layout.Item> nearItems, List<Wall> nearWalls) {
    if (outOfRoom(plate, layout)) return new Blocker("room", null);

    final List<Layout.Item> items = nearItems != null ? nearItems : layout.items;
    for (final Layout.Item other : items) {
      if (other.id == selfId) continue;
      final double[] p = catalog.footprint(other.p);
      if (p == null) continue;
      if (Geometry.overlap(plate, Geometry.corners(other.x, other.z, p[0], p[1], other.r))) {
        return new Blocker("item", other.id);
      }
    }

    final List<Wall> walls = nearWalls != null ? nearWalls : layout.walls;
    for (final Wall w : walls) {
      if (Room.isBoundaryWall(layout, w)) continue;  // 外墙 = 房间边界，已由 outOfRoom 覆盖
      // W1 门洞：把"门板扫到墙"拆成**实心子段** —— 扫到洞口不算撞墙，扫到洞旁的墙身才算
      // （与漫游碰撞同一口径；没有门洞的墙返回整段 → 行为与以前逐字一致）。
      for (final double[] seg : Openings.solidSegments(w)) {
        if (Geometry.overlap(plate, Geometry.wallBox(seg))) return new Blocker("wall", null);
      }
    }
    return null;
  }

  /**
   * 规则 7 的结果。`freeDeg` 可为 null（**没有可参与的门**，或门数据不完整 → 拒绝编造数字）。
   *
   * `skippedDoors/skipReason` 把「本来就没有门/上盖」与「有门但缺铰链」分开；
   * 后者是 n/a 但必须可解释，不能静默当成无门。
   */
  public record Result(Double freeDeg, Double maxDeg, String door, Blocker blockedBy,
                       boolean unobstructed, int doors, int skippedDoors, String skipReason) {
  }

  /** 最差的一扇门（可开角度最小者）；一型号多门时取最差 */
  public static Result doorFreeAngle(Layout layout, Layout.Item item, Catalog catalog) {
    final Catalog.DoorScan scan = catalog.planDoorScan(item.p);
    final List<Catalog.Door> doors = scan.doors();
    if (doors.isEmpty()) {
      return new Result(null, null, null, null, false, 0, scan.skipped(), scan.skipReason());
    }

    Result worst = null;
    for (final Catalog.Door door : doors) {
      final double maxDeg = Math.abs(door.openAngleDeg());
      final double sign = door.openAngleDeg() < 0 ? -1 : 1;  // JS Math.sign(x) || 1
      double freeDeg = 0;
      Blocker blocker = null;

      // ── 粗筛（与 JS 同一判据，算一次，与角度无关）──
      final double[] hg = doorHingeAt(item, door);
      final double reach = door.swing() + ParamsLive.p().spaceOverlapTolM;
      final List<Layout.Item> nearItems = new ArrayList<>();
      for (final Layout.Item o : layout.items) {
        if (o.id == item.id) continue;
        final double[] op = catalog.footprint(o.p);
        if (op == null) continue;
        if (Geometry.pointToItem(hg[0], hg[1], o.x, o.z, o.r, op[0], op[1]) <= reach) nearItems.add(o);
      }
      final List<Wall> nearWalls = new ArrayList<>();
      for (final Wall w : layout.walls) {
        if (Room.isBoundaryWall(layout, w)) continue;
        // 粗筛也要按**实心子段**判：洞口的近处没有墙身，不该把整面墙拉进候选
        for (final double[] seg : Openings.solidSegments(w)) {
          if (Geometry.segmentDistance(hg[0], hg[1], seg[0], seg[1], seg[2], seg[3])
              <= reach + ParamsLive.p().spaceWallThicknessM) {
            nearWalls.add(w);
            break;
          }
        }
      }

      // 从关门位往开的方向扫；第一步就被挡 = 0°（连关着都撞，属于摆放问题）
      for (double t = ParamsLive.p().doorSweepStepDeg; t <= maxDeg + 1e-9; t += ParamsLive.p().doorSweepStepDeg) {
        final Blocker hit = plateBlocker(doorPlateAt(item, door, sign * t), layout, item.id, catalog, nearItems, nearWalls);
        if (hit != null) {
          blocker = hit;
          break;
        }
        freeDeg = t;
      }

      final Result cand = new Result(freeDeg, maxDeg, door.node(), blocker,
          freeDeg >= maxDeg - ParamsLive.p().doorFreeTolDeg, doors.size(),
          scan.skipped(), scan.skipReason());
      if (worst == null || cand.freeDeg() < worst.freeDeg()) worst = cand;
    }
    return worst;
  }

  /** 分级：`ok` / `warn` / `bad` / `n/a`（阈值读参数表） */
  public static String clearanceLevel(Double freeDeg) {
    if (freeDeg == null) return "n/a";
    if (freeDeg >= ParamsLive.p().doorOpenOkDeg) return "ok";
    if (freeDeg >= ParamsLive.p().doorOpenWarnDeg) return "warn";
    return "bad";
  }
}