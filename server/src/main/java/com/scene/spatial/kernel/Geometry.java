package com.scene.spatial.kernel;

/**
 * Geometry.java —— 2D 几何基元
 *
 * 移植自 `spatial-core/src/geometry.js`（**逐行对齐，不是重写**）。JS 侧当初又是从原型
 * `r1/src/scripts/01_main-module.js` 的 corners()/overlap() 抽出来的，容差常数原样保留。
 * 这些常数不写死在方法里，一律读 {@link Params}（= `config/params.default.json`，与 JS 侧同源）。
 *
 * ⚠️ 改这里必须同步改 JS 侧与 `test/cases/rules.json` —— 两边结论不一致，
 *    "服务端是唯一裁判"这句话就不成立了。
 */
public final class Geometry {

  private Geometry() {}

  /** 角度 → 弧度 */
  public static final double DEG = Math.PI / 180;

  /** 退化线段阈值（与原型 len &lt; 1e-8 一致） */
  public static final double EPS = 1e-8;

  /** 与原型 toFixed(1) 等价（返回数值而非字符串） */
  public static double round1(double v) {
    return Math.round(v * 10) / 10.0;
  }

  /**
   * 旋转矩形的 4 个角（围绕中心就地旋转）。
   * 角点顺序 [(-w/2,-d/2), (w/2,-d/2), (w/2,d/2), (-w/2,d/2)] 必须与 JS 一致 ——
   * {@link #overlap} 只取前两条边做分离轴，顺序错了判定就错。
   */
  public static double[][] corners(double x, double z, double w, double d, double rDeg) {
    final double c = Math.cos(rDeg * DEG);
    final double s = Math.sin(rDeg * DEG);
    final double[][] loc = {{-w / 2, -d / 2}, {w / 2, -d / 2}, {w / 2, d / 2}, {-w / 2, d / 2}};
    final double[][] out = new double[4][2];
    for (int i = 0; i < 4; i++) {
      final double a = loc[i][0];
      final double b = loc[i][1];
      out[i][0] = x + a * c - b * s;
      out[i][1] = z + a * s + b * c;
    }
    return out;
  }

  /** 旋转后的轴对齐外接尺寸（原型 ext()） */
  public static double[] extents(double w, double d, double rDeg) {
    final double r = rDeg * DEG;
    return new double[]{
        Math.abs(w * Math.cos(r)) + Math.abs(d * Math.sin(r)),
        Math.abs(w * Math.sin(r)) + Math.abs(d * Math.cos(r)),
    };
  }

  /**
   * 两个凸多边形是否重叠（分离轴定理）。
   *
   * 原实现依次取两个多边形的前两条边（矩形即两个互相垂直的轴）投影，任一轴上
   * "投影不交叠（含 {@link Params#spaceOverlapTolM} 容差）"即判定分离。
   * **5 mm 容差必须原样保留**：贴墙/紧邻摆放的结论正卡在这 5 mm 上（FIX-04 的边界用例）。
   */
  public static boolean overlap(double[][] a, double[][] b) {
    for (final double[][] v : new double[][][]{a, b}) {
      for (int k = 0; k < 2; k++) {
        final double dx = v[k + 1][0] - v[k][0];
        final double dz = v[k + 1][1] - v[k][1];
        final double len = Math.hypot(dx, dz);
        if (len < EPS) continue;
        final double ax = -dz / len;
        final double az = dx / len;
        double minA = Double.MAX_VALUE;
        double maxA = -Double.MAX_VALUE;
        double minB = Double.MAX_VALUE;
        double maxB = -Double.MAX_VALUE;
        for (final double[] p : a) {
          final double t = p[0] * ax + p[1] * az;
          if (t < minA) minA = t;
          if (t > maxA) maxA = t;
        }
        for (final double[] p : b) {
          final double t = p[0] * ax + p[1] * az;
          if (t < minB) minB = t;
          if (t > maxB) maxB = t;
        }
        if (maxA <= minB + ParamsLive.p().spaceOverlapTolM) return false;
        if (maxB <= minA + ParamsLive.p().spaceOverlapTolM) return false;
      }
    }
    return true;
  }

  /** 轴对齐线段 → 以中点为心的"墙矩形"四角（内墙碰撞用） */
  public static double[][] wallBox(Wall wall) {
    return wallBox(wall.seg());
  }

  /** 老式四数版本（实心子段这类"手里只有坐标"的地方用；与 JS `wallBox(seg)` 同口径） */
  public static double[][] wallBox(double[] wall) {
    final double x = wall[0];
    final double z = wall[1];
    final double xx = wall[2];
    final double zz = wall[3];
    return corners((x + xx) / 2, (z + zz) / 2,
        Math.hypot(xx - x, zz - z), ParamsLive.p().spaceWallThicknessM,
        Math.atan2(zz - z, xx - x) / DEG);
  }

  /** 点到线段的距离（漫游碰撞用） */
  public static double segmentDistance(double px, double pz, double x1, double z1, double x2, double z2) {
    final double dx = x2 - x1;
    final double dz = z2 - z1;
    final double len2 = dx * dx + dz * dz;
    if (len2 < EPS) return Math.hypot(px - x1, pz - z1);
    double t = ((px - x1) * dx + (pz - z1) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), pz - (z1 + t * dz));
  }

  /**
   * 点到**旋转后的设备占地矩形**的距离（0 = 在矩形内）。规则 7 的粗筛用它。
   * 做法：把点反旋转到设备本地坐标（与 {@link #corners} 的 +r 互为逆），再按轴对齐矩形算。
   */
  public static double pointToItem(double px, double pz, double ix, double iz, double rDeg, double w, double d) {
    final double dx = px - ix;
    final double dz = pz - iz;
    final double r = rDeg * DEG;
    final double lx = dx * Math.cos(r) + dz * Math.sin(r);
    final double lz = -dx * Math.sin(r) + dz * Math.cos(r);
    final double ex = Math.max(Math.abs(lx) - w / 2, 0);
    final double ez = Math.max(Math.abs(lz) - d / 2, 0);
    return Math.hypot(ex, ez);
  }
}