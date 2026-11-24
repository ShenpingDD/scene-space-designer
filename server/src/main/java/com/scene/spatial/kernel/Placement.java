package com.scene.spatial.kernel;

/**
 * Placement.java —— 规则 3：自动摆位与增删移转
 *
 * 移植自 `spatial-core/src/placement.js`（原型 `add()` 的空位扫描 + 拖拽夹取 + 旋转吸附），
 * 含 R1 修复：**FIX-05**（写入端上限/坐标夹取，保证导出必可回导）、**FIX-06**（空位校验）。
 *
 * ⚠️ 摆位**顺序**是判据的一部分：Z 由小到大、X 由小到大，步长 0.7 / 1.1 / 1.2。
 *    用例 `placement-auto-spot` 期望空房间第一台落在 (0.7, 0.7) —— 扫描顺序一改，这个数就变。
 *
 * 与 JS 的一处实现差异（不影响语义）：JS 返回**新布局**（不可变风格），
 * Java 侧**就地追加**并返回是否成功。布局的拷贝与撤销由 history 层负责，
 * 这里少一层拷贝，调用方读起来更直白。
 */
public final class Placement {

  private Placement() {
  }

  /**
   * 文案一律用方法而不是常量：配置值可在运行时被改（后台基础配置），
   * 常量会在类初始化时被"抄"死 —— 那就成了两处真相。JS 侧同款纪律（`LIMITS` 全用 getter）。
   */
  public static String limitMsg() {
    return "最多放置 " + ParamsLive.p().layoutMaxItems + " 台设备，请先移除部分设备";
  }

  public static String wallLimitMsg() {
    return "墙体数量已达上限（" + ParamsLive.p().layoutMaxWalls + " 面）";
  }

  public static final String MSG_UNKNOWN = "未知型号，无法加入";
  public static final String MSG_NO_SPACE = "空间不足，无法再放置；可先扩大空间或移除部分设备";
  public static final String MSG_BAD_POINT = "墙体坐标不合法（坐标必须是有限数字）";

  public static String wallTooShortMsg() {
    return "墙体太短：至少 " + ParamsLive.p().schemeMinWallLengthM + " m";
  }

  /** 下一个可用 id（导入后的恢复口径，也是 FIX-25 的兜底） */
  public static int nextIdFor(Layout layout) {
    int max = 0;
    for (final Layout.Item i : layout.items) max = Math.max(max, i.id);
    return max + 1;
  }

  /** 原型 `add()` 的空位扫描：Z 由小到大、X 由小到大，逐格试放。返回 null = 没地方了 */
  public static double[] findFreeSpot(Layout layout, Layout.Item probe, Catalog catalog) {
    for (double z = ParamsLive.p().layoutAutoZ0; z < layout.d - ParamsLive.p().layoutAutoMargin; z += ParamsLive.p().layoutAutoDz) {
      for (double x = ParamsLive.p().layoutAutoX0; x < layout.w - ParamsLive.p().layoutAutoMargin; x += ParamsLive.p().layoutAutoDx) {
        final double px = Geometry.round1(x);
        final double pz = Geometry.round1(z);
        final Layout.Item t = new Layout.Item(probe.id, probe.p, px, pz, probe.r, probe.doorAmount);
        if (Validate.isValid(layout, t, catalog)) return new double[]{px, pz};
      }
    }
    return null;
  }

  /** `addItem` 的结果。`reason`：`limit` / `unknown-product` / `no-space` */
  public record Result(boolean ok, String reason, Layout.Item item) {
  }

  /**
   * 加入一台设备。顺序严格对齐原型：
   * **上限 → 型号存在 → 位置（给了坐标就夹取，没给就自动找空位）→ 空位失败则不新增**。
   *
   * @param px 指定坐标（米）；传 null = 自动找空位
   * @param id 指定编号；传 null = 取 {@link #nextIdFor}
   */
  public static Result addItem(Layout layout, String productId, Catalog catalog,
                               Double px, Double pz, Integer id) {
    if (layout.items.size() >= ParamsLive.p().layoutMaxItems) return new Result(false, "limit", null);
    if (catalog.footprint(productId) == null) return new Result(false, "unknown-product", null);

    final boolean hasPos = px != null && pz != null;
    double x;
    double z;
    if (hasPos) {
      final double[] c = Room.clampToRoom(layout, px, pz);
      x = Geometry.round1(c[0]);
      z = Geometry.round1(c[1]);
    } else {
      x = Geometry.round1(layout.w / 2);
      z = Geometry.round1(layout.d / 2);
    }

    // FIX-05：结构从一开始就与导入端一致（含 doorAmount），导出才可逐字节往返
    final Layout.Item item = new Layout.Item(id != null ? id : nextIdFor(layout), productId, x, z, 0, 0);

    Layout.Item placed = item;
    if (!hasPos) {
      final double[] spot = findFreeSpot(layout, item, catalog);
      if (spot == null) return new Result(false, "no-space", null);
      placed = new Layout.Item(item.id, item.p, spot[0], spot[1], 0, 0);
    }
    layout.items.add(placed);
    return new Result(true, null, placed);
  }
}