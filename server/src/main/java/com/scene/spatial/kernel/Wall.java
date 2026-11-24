package com.scene.spatial.kernel;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Wall.java —— 墙的记录形状（**唯一一份**；镜像 `spatial-core/src/wall.js`）
 *
 * ## 为什么有它（W1 门洞，docs/66 §2.1）
 *
 * 墙原来是 `double[4]`（`[x,z,xx,zz]`）。门洞要挂在墙上、还要在"改房间尺寸 / 删墙"引起的
 * 墙列表重排之后**仍然指着原来那面墙** —— 用下标指墙会静默错指，所以门洞必须是墙自己的字段：
 *
 *     { a: [x, z], b: [x, z], openings: [{ at, w, h }] }              ← 门（kind 缺省）
 *     { a: [x, z], b: [x, z], openings: [{ at, w, h, kind, sill }] }  ← 窗（W2）
 *
 * ## 洞口的记录形状也只有这一份（W2 窗，docs/78 §2.3）
 *
 * ⚠️ `{ at, w, h }` 这个形状在代码里曾是**手抄的**，一共 6 处窄门（JS 侧 `mkWall`/`readWall`/
 * `withOpenings`/`room`，以及本类旁边的 `Scheme` 读写）—— 每一处都「只认识 3 个字段」，
 * 新加进来的 `kind`/`sill` 会在这些地方**无警告消失**，而且消失得很晚
 * （保存→读回→分享→交付某一环）、很难查。所以洞口的造/读/拷收进 `Wall` 与 `wall.js`
 * （唯一一份），改形状时任何一处还手抄 `{at,w,h}` 都会立刻露馅。
 *
 * 写法冻结：**`kind` 只在窗上写，门省略它** —— 于是所有含门洞的方案导出字节逐字不变。
 * 字段顺序 `at` / `w` / `h` / `kind` / `sill` 与 JS `wall.js mkOpening()` 必须一致
 * （顺序也是逐字节比对的一部分；见 `Scheme.wallJson`）。
 *
 * `at` 是门洞中心**沿墙自 `a` 起**的弧长（米），不是 0..1 比例 —— 比例会在墙变长时
 * 把洞悄悄挪位置（静默改数）。这一条与 JS 侧、与用例表逐字同口径。
 *
 * 老式四数读法一律走 {@link #seg()}（与 JS `wallSeg()` 同一个名字、同一个含义）——
 * 目的就是让"按数组读墙"这件事不可能悄悄发生：形状一改，任何一处还写 `w[0]` 都会拿到
 * 越界或错值，而墙会被当零长跳过（渲染里静默少一截）。
 */
public final class Wall {

  /** 端点（世界坐标，米） */
  public final double[] a;
  public final double[] b;
  /** 窗的 `kind` 字面量（门**不写** `kind` —— 缺省即门，与 JS `wall.js` 同一条口径） */
  public static final String WINDOW = "window";

  /**
   * 墙的角色（W3 开放场景，镜像 `spatial-core/src/wall.js` 与 `room.wallRole`）：
   * `exterior`（外墙）/ `interior`（内墙）/ `null`（**没标注**）。
   *
   * ⚠️ `null` **不是**"内墙"，而是"按几何回退"：旧文件没有这个字段，
   * 缺省当内墙会让旧方案的四面外墙突然开始挡设备、门扇净空突然报警 —— 用户什么都没改。
   */
  public String role;

  public static final String EXTERIOR = "exterior";
  public static final String INTERIOR = "interior";

  /** 认得的角色（**只有两个 ASCII 枚举**；认不得的值一律当没写，不拒整份文件） */
  public static final List<String> ROLES = List.of(EXTERIOR, INTERIOR);

  /**
   * 宽容读一个角色：合法就返回，缺省/认不得返回 `null`（= 当没写）。
   * 与 JS `scheme.js readWallRole()` 同一口径 —— 不报错、不猜、不回就近值。
   */
  public static String readRole(Object v) {
    return v instanceof String s && ROLES.contains(s) ? s : null;
  }

  /** 这面墙标注的角色（合法才返回，否则 `null` —— 调用方的几何回退在 `Room.wallRole`） */
  public String roleOrNull() {
    return readRole(role);
  }

  /** 带角色地复制一面墙（用例/夹具用；写端不会自己造角色） */
  public Wall withRole(String r) {
    role = readRole(r);
    return this;
  }

  /** 墙上的洞口（门洞与窗，按 `at` 升序 —— 几何是"相邻两洞之间那段墙"，不排序会算出自相交的区间） */
  public final List<Opening> openings = new ArrayList<>();

  public Wall(double ax, double az, double bx, double bz) {
    this.a = new double[]{ax, az};
    this.b = new double[]{bx, bz};
  }

  public static Wall of(double ax, double az, double bx, double bz) {
    return new Wall(ax, az, bx, bz);
  }

  /** 四周外墙（原型 defaultWalls）—— 顺序与 JS `boundaryWalls()` 一致 */
  public static List<Wall> boundaryWalls(double w, double d) {
    final List<Wall> out = new ArrayList<>();
    out.add(Wall.of(0, 0, w, 0));
    out.add(Wall.of(w, 0, w, d));
    out.add(Wall.of(w, d, 0, d));
    out.add(Wall.of(0, d, 0, 0));
    return out;
  }

  /** 老式四数读法 `[x, z, xx, zz]`（与 JS `wallSeg()` 同口径） */
  public double[] seg() {
    return new double[]{a[0], a[1], b[0], b[1]};
  }

  public double len() {
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  /** 深拷贝（改房间尺寸 / 快照用；门洞与角色一起带走 —— 漏了 role 会让角色在编辑后静默消失） */
  public Wall copy() {
    final Wall w = new Wall(a[0], a[1], b[0], b[1]);
    w.openings.addAll(openings);
    w.role = roleOrNull();
    return w;
  }

  /** 换一批门洞（自动按 `at` 排序；顺序与 JS `withOpenings()` 一致）。角色原样带走 */
  public Wall withOpenings(List<Opening> list) {
    final List<Opening> sorted = new ArrayList<>(list);
    sorted.sort(Comparator.comparingDouble(o -> o.at));
    final Wall w = new Wall(a[0], a[1], b[0], b[1]);
    w.openings.addAll(sorted);
    w.role = roleOrNull();
    return w;
  }

  /* ---------------- 洞口的记录形状：与 JS `wall.js` 一一对应 ---------------- */

  /** 洞口类别：`"door"`（**缺省**）或 `"window"`（认不得的一律当门 —— 与 JS `kindOf` 同规矩） */
  public static String kindOf(Wall.Opening o) {
    return o != null && WINDOW.equals(o.kind()) ? WINDOW : "door";
  }

  /** 洞口底边**离地高度**（米）：门恒 0；窗取 `sill`（非有限数/负数退回 0 —— 结构校验该拦的事） */
  public static double sillOf(Wall.Opening o) {
    if (!WINDOW.equals(kindOf(o))) return 0;
    final double v = o.sill();
    return !Double.isNaN(v) && !Double.isInfinite(v) && v > 0 ? v : 0;
  }

  /** 洞口类别的人话名（内核出话、界面原样转述 —— 文案只有一份，与 JS `holeName` 同字） */
  public static String holeName(String kind) {
    return WINDOW.equals(kind) ? "窗" : "门洞";
  }

  /** 门洞（缺省类别）×N —— ⭐ **只有门能走人**，窗不在其列（`Openings.solidSegments` 用它） */
  public List<Opening> doorOpenings() {
    final List<Opening> out = new ArrayList<>();
    for (final Opening o : openings) if (!o.isWindow()) out.add(o);
    return out;
  }

  /** 窗 ×N */
  public List<Opening> windowOpenings() {
    final List<Opening> out = new ArrayList<>();
    for (final Opening o : openings) if (o.isWindow()) out.add(o);
    return out;
  }

  @Override
  public String toString() {
    return "Wall(" + a[0] + "," + a[1] + " → " + b[0] + "," + b[1] + " 洞 " + openings.size() + ")";
  }

  /**
   * 一个洞口（镜像 JS 的 `{ at, w, h }` / 窗 `{ at, w, h, kind, sill }`）。
   *
   * 三参数的构造器是**门**（老文件里没有 `kind`，读出来就是门）—— 留着它是为了让
   * 「门」这条路与 W1 逐字相同（零回归的前提）。
   */
  public record Opening(double at, double w, double h, String kind, double sill) {

    public Opening(double at, double w, double h) {
      this(at, w, h, null, 0);
    }

    public boolean isWindow() {
      return WINDOW.equals(kind);
    }
  }
}