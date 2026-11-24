package com.scene.spatial.kernel;

import java.util.ArrayList;
import java.util.List;

/**
 * Openings.java —— 门洞（建筑门洞 = 墙上的洞口）：结构校验 + 实心子段（镜像 `openings.js`）
 *
 * ## 服务端**不做**的事（说清楚，免得下一个人在这里补一版）
 *
 * 放置（拖拽/点击）、夹取、上下限、每墙上限、2D/3D 渲染全部是**客户端**的事：
 * 那些要指针、要参数表里的可改策略。服务端只做两件：
 *   ① **导入侧的结构体检**：跑到墙外 / 比墙高 / 两洞重叠 / 超过格式上限 → 拒绝（这不是本应用的文件）；
 *   ② **碰撞用的实心子段**：漫游碰撞、开门净空都要"洞口处不挡、洞旁照旧挡"。
 *
 * ⚠️ 与可改参数有关的边界（最小/最大净宽、离墙角间隙、每墙上限）**不在导入侧拒绝** ——
 * 那些是现场可改的策略，拿"今天的策略"去拒绝"昨天导出的文件"就是 FIX-05 的反面。
 * 这条口径与 JS 侧 `checkWallOpenings(..., "tolerant")` 一模一样。
 */
public final class Openings {

  private Openings() {
  }

  /** 每面墙门洞数的**格式上限**（不是策略上限；策略上限是 `opening.maxPerWall`，可在后台改） */
  public static final int HARD_LIMIT = 10;

  /** 结构问题（导入要拒）。与 JS `OPENING_REASON` 同名同义 */
  public record Problem(String reason, String message) {
  }

  public static final String BAD_OPENING = "bad-opening";
  /** 窗的离地高度不合法（不是有限数 / 是负数）—— 与 JS `OPENING_REASON.BAD_SILL` 同名同义 */
  public static final String BAD_SILL = "opening-bad-sill";
  public static final String OFF_WALL = "opening-off-wall";
  public static final String OVERLAP = "opening-overlap";
  public static final String TOO_TALL = "opening-too-tall";
  public static final String TOO_MANY = "opening-too-many";

  /** 洞口中心沿墙的弧长区间 `[起, 止]` */
  public static double[] span(Wall.Opening o) {
    return new double[]{o.at() - o.w() / 2, o.at() + o.w() / 2};
  }

  /** 一面墙上所有**洞口**的区间（门与窗一起：重叠判定要跨类别），按起点排序；每项 `[gs, ge]` */
  public static List<double[]> spans(Wall wall) {
    final List<double[]> out = new ArrayList<>();
    for (final Wall.Opening o : wall.openings) out.add(span(o));
    out.sort((p, q) -> Double.compare(p[0], q[0]));
    return out;
  }

  /**
   * 一面墙上**门洞**的区间（碰撞/漫游/开门净空用）—— ⭐ **窗不在这里**。
   *
   * 门洞最本质的作用是「这儿能过去」（把洞那段从碰撞线段里删掉）；窗绝不能这么做，
   * 否则人就从窗里走出去，而且界面上完全看不出来（墙上有洞、看着对）。
   * 与 JS `wallSolidSegments()` 同算式（那边用的是 `doorSpans`）。
   */
  public static List<double[]> doorSpans(Wall wall) {
    final List<double[]> out = new ArrayList<>();
    for (final Wall.Opening o : wall.doorOpenings()) out.add(span(o));
    out.sort((p, q) -> Double.compare(p[0], q[0]));
    return out;
  }

  private static boolean finite(double v) {
    return !Double.isNaN(v) && !Double.isInfinite(v);
  }

  /**
   * 单扇门洞的**结构**校验（与策略参数无关）。
   *
   * @return null = 结构合法
   */
  public static Problem structuralProblem(Wall wall, Wall.Opening o, double roomH) {
    final String kind = Wall.kindOf(o);
    if (o == null || !finite(o.at()) || !finite(o.w()) || !finite(o.h())) {
      return new Problem(BAD_OPENING, "无法导入：" + Wall.holeName(kind) + "数据不合法（位置与尺寸必须是有限数字）");
    }
    final double len = wall.len();
    if (!(o.w() > 1e-6) || o.w() > len + 1e-9) {
      return new Problem(OFF_WALL, "无法导入：门洞数据不合法（洞口跑到墙外、比墙高、或两个洞重叠）");
    }
    final double[] sp = span(o);
    if (sp[0] < -1e-6 || sp[1] > len + 1e-6) {
      return new Problem(OFF_WALL, "无法导入：门洞数据不合法（洞口跑到墙外、比墙高、或两个洞重叠）");
    }
    if (!(o.h() > 1e-6) || (finite(roomH) && o.h() > roomH + 1e-6)) {
      return new Problem(TOO_TALL, "无法导入：" + Wall.holeName(kind) + "数据不合法（洞口跑到墙外、比墙高、或两个洞重叠）");
    }
    // 窗的竖直约束：离地是有限数、不为负，且**洞顶不许穿出墙顶**（离地 + 净高 ≤ 墙高）
    if (Wall.WINDOW.equals(kind)) {
      if (!finite(o.sill()) || o.sill() < -1e-6) {
        return new Problem(BAD_SILL, "无法导入：窗的离地高度不合法（必须是 0 以上的有限数字）");
      }
      if (finite(roomH) && o.sill() + o.h() > roomH + 1e-6) {
        return new Problem(TOO_TALL, "无法导入：窗比墙还高（离地高度 + 净高 不能超过墙高）");
      }
    }
    return null;
  }

  /**
   * 一整面墙的门洞体检（结构 + 两两重叠 + 个数）。
   *
   * @param tolerant true = 忽略**策略**个数上限（导入用）；格式上限（{@link #HARD_LIMIT}）始终生效
   */
  public static Problem checkWallOpenings(Wall wall, double roomH, boolean tolerant) {
    if (wall.openings.isEmpty()) return null;
    // 每墙上限**按类别各算各的**（一面墙可以 3 门 + 3 窗；与 JS `checkWallOpenings` 同口径）
    if (!tolerant) {
      final int doorMax = ParamsLive.p().openingMaxPerWall;
      if (wall.doorOpenings().size() > doorMax) {
        return new Problem(TOO_MANY, "一面墙最多 " + doorMax + " 个门洞");
      }
      final int winMax = ParamsLive.p().windowMaxPerWall;
      if (wall.windowOpenings().size() > winMax) {
        return new Problem(TOO_MANY, "一面墙最多 " + winMax + " 个窗");
      }
    }
    if (wall.openings.size() > HARD_LIMIT) {
      return new Problem(TOO_MANY, "一面墙最多 " + HARD_LIMIT + " 个洞口（门洞与窗合计）");
    }
    for (final Wall.Opening o : wall.openings) {
      final Problem p = structuralProblem(wall, o, roomH);
      if (p != null) return p;
    }
    final List<double[]> sp = spans(wall);
    for (int i = 1; i < sp.size(); i++) {
      final double[] prev = sp.get(i - 1);
      final double[] cur = sp.get(i);
      // 恰好相接 = 不重叠（留 1e-6 容差给取整）
      if (cur[0] < prev[1] - 1e-6 && prev[0] < cur[1] - 1e-6) {
        return new Problem(OVERLAP, "无法导入：门洞数据不合法（洞口跑到墙外、比墙高、或两个洞重叠）");
      }
    }
    return null;
  }

  /**
   * 一面墙的**实心子段**（碰撞/漫游/开门净空用）：**门洞**的位置整段不挡人，其余照旧挡。
   *
   * ⭐ **窗不在这里**：窗那一块墙照旧是实心的 —— 人不能从窗里走出去。
   * 用 `doorSpans()` 而不是 `spans()` 就是这一条的全部实现（JS 侧同）。
   *
   * 为什么不写"整墙判定、洞区间 if-else 放行"：那样 0.1 m 的缝也能钻过去 ——
   * 子段喂给同一个距离函数才是对的几何（窄洞自然过不去：两侧都要留出人体半径）。
   * 与 JS `wallSolidSegments()` 同算式。
   *
   * @return 每段 `[x1, z1, x2, z2]`；没有门洞时就是整段（行为与以前逐字一致）
   */
  public static List<double[]> solidSegments(Wall wall) {
    final List<double[]> out = new ArrayList<>();
    final double len = wall.len();
    if (!(len > 1e-12)) return out;
    final double dx = (wall.b[0] - wall.a[0]) / len;
    final double dz = (wall.b[1] - wall.a[1]) / len;
    final List<double[]> cut = doorSpans(wall);
    if (cut.isEmpty()) {
      out.add(new double[]{wall.a[0], wall.a[1], wall.b[0], wall.b[1]});
      return out;
    }
    double cursor = 0;
    for (final double[] sp : cut) {
      final double gs = Math.max(0, sp[0]);
      if (gs - cursor > 1e-9) {
        out.add(new double[]{
            wall.a[0] + dx * cursor, wall.a[1] + dz * cursor,
            wall.a[0] + dx * gs, wall.a[1] + dz * gs});
      }
      cursor = Math.max(cursor, Math.min(len, sp[1]));
    }
    if (len - cursor > 1e-9) {
      out.add(new double[]{
          wall.a[0] + dx * cursor, wall.a[1] + dz * cursor,
          wall.b[0], wall.b[1]});
    }
    return out;
  }
}