package com.scene.spatial.kernel;

import java.util.ArrayList;
import java.util.List;

/**
 * Room.java —— 规则 2：空间与墙
 *
 * 移植自 `spatial-core/src/room.js`（含 R1 的 FIX-03：改尺寸时保留内墙，
 * 且**边界墙必须在旧房间口径下判定** —— 否则旧外墙会被误认为内墙而留下）。
 */
public final class Room {

  private Room() {}

  /** 房间尺寸范围（读 {@link Params}，与 JS 侧 cfg 同源） */
  public static double[][] roomLimits() {
    return new double[][]{
        {ParamsLive.p().roomMinW, ParamsLive.p().roomMaxW},
        {ParamsLive.p().roomMinD, ParamsLive.p().roomMaxD},
        {ParamsLive.p().roomMinH, ParamsLive.p().roomMaxH},
    };
  }

  /**
   * 范围文案 —— **唯一一份**：报错、导入校验、界面提示都说这一句。
   *
   * 用例 `room-resize-out-of-range` 的期望值就是这个字符串，所以**格式不能动**：
   * 必须与 JS 侧逐字符相同（含"范围"二字、全角逗号、U+2013 连接号）。
   * 数字排版也要一致：JS 模板串对整数 3 输出 `3` 而不是 `3.0` —— 见 {@link #num}。
   */
  public static String roomRangeText() {
    final double[][] r = roomLimits();
    return "长宽范围 " + num(r[0][0]) + "–" + num(r[0][1]) + " m，墙高 "
        + num(r[2][0]) + "–" + num(r[2][1]) + " m";
  }

  /** 数字 → 文案：整数不带小数点（对齐 JS 模板串的行为） */
  static String num(double v) {
    return v == Math.floor(v) && !Double.isInfinite(v) ? String.valueOf((long) v) : String.valueOf(v);
  }

  /** 四面外墙（原型 defaultWalls） */
  public static List<Wall> boundaryWalls(double w, double d) {
    return Wall.boundaryWalls(w, d);
  }

  /**
   * 外墙贴在哪条边界线上（L/R/T/B）。
   * 外墙的**端点方向是固定的**（T 面自 (0,0) 向 (w,0)、R 面自 (w,0) 向 (w,d)、
   * B 面自 (w,d) 向 (0,d)、L 面自 (0,d) 向 (0,0)），所以"门洞在这面墙上的弧长 `at`"
   * 在房间变大变小之后**指的是同一个锚角**，可以原样带走（见 {@link #applyRoomSize}）。
   * 与 JS `boundarySide()` 同口径。
   */
  public static String boundarySide(Layout room, Wall wall) {
    final List<String> a = wallSides(room.w, room.d, wall.a[0], wall.a[1], 1e-6);
    final List<String> b = wallSides(room.w, room.d, wall.b[0], wall.b[1], 1e-6);
    for (final String s : a) {
      if (b.contains(s)) return s;
    }
    return null;
  }

  /** 点落在房间哪几条边界线上：L/R/T/B（原型 wallSides，容差 1e-6） */
  public static List<String> wallSides(double w, double d, double x, double z, double e) {
    final List<String> s = new ArrayList<>();
    if (Math.abs(x) < e) s.add("L");
    if (Math.abs(x - w) < e) s.add("R");
    if (Math.abs(z) < e) s.add("T");
    if (Math.abs(z - d) < e) s.add("B");
    return s;
  }

  /**
   * 墙的角色（W3 开放场景，镜像 `spatial-core/src/room.js wallRole()`）：
   * **语义优先、几何回退**。
   *
   *   ① 墙自己标了合法角色（`exterior` / `interior`）→ 用它。角色是**持久化语义**，
   *      不由渲染层用几何猜 —— 否则扩场景之后同一面墙会在"显示为外墙 / 实际挡设备"之间漂移。
   *   ② 没标（旧文件、或者这面墙本来就没分类）→ 用几何判据：两端点贴在**同一条**边界线上 = 外墙。
   *
   * ⚠️ 缺省**不是** `interior`：旧方案的四面外墙没有 `role`，按几何回退它们仍是外墙；
   *    若把缺省当内墙，一次保存就会让旧方案的设备突然"压墙"、门扇净空突然报警。
   *
   * @return {@link Wall#EXTERIOR} / {@link Wall#INTERIOR}（**恒有值**）
   */
  public static String wallRole(Layout room, Wall wall) {
    final String marked = wall == null ? null : wall.roleOrNull();
    if (marked != null) return marked;
    return geometricBoundaryWall(room, wall) ? Wall.EXTERIOR : Wall.INTERIOR;
  }

  /** 该墙是否为外墙：`wallRole()` 的薄封装（与 JS `isBoundaryWall` 同为薄封装） */
  public static boolean isBoundaryWall(Layout room, Wall wall) {
    return Wall.EXTERIOR.equals(wallRole(room, wall));
  }

  /**
   * 纯几何判据：两端点都贴在**同一条**边界线上（原型 isBoundaryWall）。
   *
   * 它是 `wallRole` 的**回退分支**，不再对外承担语义 —— 扩场景之后"贴着新边缘的旧围墙"
   * 与"留在中间的旧外墙"都靠 `role` 认，几何只回答"没标注时按老规矩算是什么"。
   */
  private static boolean geometricBoundaryWall(Layout room, Wall wall) {
    final List<String> a = wallSides(room.w, room.d, wall.a[0], wall.a[1], 1e-6);
    final List<String> b = wallSides(room.w, room.d, wall.b[0], wall.b[1], 1e-6);
    if (a.isEmpty() || b.isEmpty()) return false;
    for (final String s : a) {
      if (b.contains(s)) return true;
    }
    return false;
  }

  /** 尺寸校验：返回中文错误信息或 null（原型 applyRoom 的范围提示原样保留） */
  public static String validateRoomSize(double w, double d, double h) {
    final double[][] L = roomLimits();
    if (!finite(w) || !finite(d) || !finite(h)) return roomRangeText();
    if (w < L[0][0] || w > L[0][1]) return roomRangeText();
    if (d < L[1][0] || d > L[1][1]) return roomRangeText();
    if (h < L[2][0] || h > L[2][1]) return roomRangeText();
    return null;
  }

  private static boolean finite(double v) {
    return !Double.isNaN(v) && !Double.isInfinite(v);
  }

  /**
   * 改空间尺寸的结果（原型只返回新 state，这里如实带上 kept/removed 供 UI 提示）。
   * W1 起还带上门洞的两个数：**跟走了几个、放不下删了几个** —— 许静默丢就是许丢数据。
   */
  public record Apply(boolean ok, String error, Layout layout, int kept, int removed,
                      int openingsKept, int openingsDropped) {
  }

  /**
   * 改空间尺寸（FIX-03）：重建四面外墙 + **保留仍在新范围内的内墙**。
   *
   * 两个易错点（R1 实测踩过）：
   *  1. {@link #isBoundaryWall} 必须用**旧**房间尺寸判定，否则旧外墙会被当成内墙处理；
   *  2. 原型此步会静默删除内墙，toast 却说"可撤销恢复" —— 这里如实返回 kept/removed。
   *
   * W1：内墙**连门洞一起**带走（墙是对象，门洞是它的字段）；外墙是重建的，但四个面的锚角
   * 方向固定，外墙上的门洞按"同一个锚角 + 同一个弧长"搬过去，搬过去放不下的丢掉并计数。
   * 逐条对齐 JS `applyRoomSize()`（用例表两侧跑同一张）。
   */
  public static Apply applyRoomSize(Layout layout, double w, double d, double h) {
    final String error = validateRoomSize(w, d, h);
    if (error != null) return new Apply(false, error, null, 0, 0, 0, 0);

    final List<Wall> inner = new ArrayList<>();
    for (final Wall wl : layout.walls) {
      if (!isBoundaryWall(layout, wl)) inner.add(wl);
    }

    // 四个坐标**全部**比一遍（与 JS 同口径）：只比一半的话，"另一头越界"的墙会被留下
    final List<Wall> kept = new ArrayList<>();
    for (final Wall wl : inner) {
      if (inside(wl.a[0], w) && inside(wl.a[1], d) && inside(wl.b[0], w) && inside(wl.b[1], d)) kept.add(wl);
    }

    // 外墙上的门洞与**显式角色**：都按"面"搬家（门洞的弧长指的还是同一个锚角）
    final java.util.Map<String, Wall> oldBySide = new java.util.HashMap<>();
    // W3：重建 ≠ 换身份 —— 旧外墙标了 `exterior` 的，重建之后同一面还是 `exterior`；
    // 漏了这一句，用户改一次房间尺寸，墙的角色就静默退回"按几何猜"（与 JS `roleBySide` 同口径）。
    final java.util.Map<String, String> roleBySide = new java.util.HashMap<>();
    for (final Wall wl : layout.walls) {
      if (!isBoundaryWall(layout, wl)) continue;
      final String side = boundarySide(layout, wl);
      if (side == null) continue;
      if (!oldBySide.containsKey(side)) oldBySide.put(side, wl);
      if (!roleBySide.containsKey(side) && wl.roleOrNull() != null) roleBySide.put(side, wl.roleOrNull());
    }
    final Layout probe = new Layout(w, d, h);
    int openingsKept = 0;
    for (final Wall wl : kept) openingsKept += wl.openings.size();
    int openingsDropped = 0;
    final List<Wall> nextBoundary = new ArrayList<>();
    for (final Wall wl : boundaryWalls(w, d)) {
      final String side = boundarySide(probe, wl);
      final Wall old = side == null ? null : oldBySide.get(side);
      Wall built = wl;
      if (old != null && !old.openings.isEmpty()) {
        final List<Wall.Opening> keep = new ArrayList<>();
        for (final Wall.Opening o : old.openings) {
          if (Openings.structuralProblem(wl, o, h) == null) keep.add(o);
        }
        openingsKept += keep.size();
        openingsDropped += old.openings.size() - keep.size();
        if (!keep.isEmpty()) built = wl.withOpenings(keep);
      }
      final String role = side == null ? null : roleBySide.get(side);
      nextBoundary.add(role == null ? built : built.withRole(role));
    }

    final Layout next = new Layout(w, d, h);
    next.walls.addAll(nextBoundary);
    for (final Wall wl : kept) next.walls.add(wl.copy());
    next.items.addAll(layout.items);
    next.wallStyle = layout.wallStyle;
    return new Apply(true, null, next, kept.size(), inner.size() - kept.size(), openingsKept, openingsDropped);
  }

  private static boolean inside(double v, double hi) {
    return v >= 0 && v <= hi;
  }

  /** 位置夹取到房间内 */
  public static double[] clampToRoom(Layout room, double x, double z) {
    return new double[]{Math.max(0, Math.min(room.w, x)), Math.max(0, Math.min(room.d, z))};
  }

  /** 空布局（原型初始值 8×6×2.8） */
  public static Layout createLayout(double w, double d, double h) {
    final Layout l = new Layout(w, d, h);
    l.walls.addAll(boundaryWalls(w, d));
    return l;
  }}