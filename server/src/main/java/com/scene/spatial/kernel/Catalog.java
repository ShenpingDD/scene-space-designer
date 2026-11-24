package com.scene.spatial.kernel;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Catalog.java —— 型号目录（Java 侧的 `getProduct()`）
 *
 * 数据来自用例表自带的 `catalog`（已生成进 {@link Cases}）：占地包络 `w/d` + 实测门数据。
 * 与 JS 侧 `getProduct(id)` 返回**同形** —— 这一层存在的意义是：**内核不关心数据从哪来**
 * （现在来自用例表，上线后来自 `product` / `product_model` 两张表）。换来源不动判据。
 */
public final class Catalog {

  /** 一扇门的实测数据（字段名与 JS 侧一致；长度米、角度度） */
  public record Door(String node, String axis, double openAngleDeg,
                     double hingeX, double hingeY, double hingeZ,
                     double x0, double x1, double z0, double z1, double swing) {
  }

  private final Map<String, Object> raw;

  public Catalog(Map<String, Object> raw) {
    this.raw = raw;
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> entry(String id) {
    final Object o = raw.get(id);
    return o instanceof Map ? (Map<String, Object>) o : null;
  }

  /** 占地包络 `{w, d}`（米）；未知型号返回 null（内核据此报 `unknown-product`） */
  public double[] footprint(String id) {
    final Map<String, Object> e = entry(id);
    if (!(e != null && e.get("w") instanceof Number && e.get("d") instanceof Number)) return null;
    return new double[]{((Number) e.get("w")).doubleValue(), ((Number) e.get("d")).doubleValue()};
  }

  /**
   * 一次扫描的结果：可参与平面净空的门 + 被排除的 y 门数量/第一原因。
   *
   * `skipped` 必须能说出口 —— 有门却缺铰链不是「没有门」，不能静默当成 n/a。
   */
  public record DoorScan(List<Door> doors, int skipped, String skipReason) {
  }

  /** 门数据缺什么；`null` = 可用，非 `y` 门由调用方先过滤。 */
  private static String doorProblem(Map<String, Object> d) {
    if (!(d.get("hinge") instanceof Map<?, ?> hg) || !(hg.get("x") instanceof Number)
        || !(hg.get("z") instanceof Number)) return "missing-hinge";
    if (!(d.get("leaf") instanceof Map<?, ?> lf)
        || !(lf.get("x0") instanceof Number) || !(lf.get("x1") instanceof Number)
        || !(lf.get("z0") instanceof Number) || !(lf.get("z1") instanceof Number)) return "missing-leaf";
    if (!(d.get("swing") instanceof Number sw) || sw.doubleValue() <= 0) return "missing-swing";
    if (!(d.get("openAngleDeg") instanceof Number ag) || ag.doubleValue() == 0) return "missing-angle";
    return null;
  }

  /**
   * 扫描参与平面净空的门：**只取 `axis == "y"`**，并跳过缺铰链/门板/扫掠半径/开角的门。
   *
   * 上盖（`axis == "x"`）是往**竖直**方向掀的，平面上本来就不占地方 ——
   * 用例 `door-clearance-lid-not-in-plan` 期望 `freeDeg = null` / `level = n/a`，判据就是这一行。
   *
   * 为什么不直接 `((Number) hg.get("x"))`：真实目录里已经有只有 `pivotMm`、没有
   * `hinge/leaf/swing` 的门（demo-blender-001）。旧实现会 NPE，把整台设备甚至整屋净空打断；
   * 这里把它归为「门数据不完整」，不补 0、不猜坐标。
   */
  @SuppressWarnings("unchecked")
  public DoorScan planDoorScan(String id) {
    final Map<String, Object> e = entry(id);
    final List<Door> out = new ArrayList<>();
    int skipped = 0;
    String skipReason = null;
    if (e == null) return new DoorScan(List.copyOf(out), skipped, null);
    final Object ds = e.get("doors");
    if (!(ds instanceof List)) return new DoorScan(List.copyOf(out), skipped, null);
    for (final Object o : (List<Object>) ds) {
      if (!(o instanceof Map)) continue;
      final Map<String, Object> d = (Map<String, Object>) o;
      if (!"y".equals(d.get("axis"))) continue;
      final String problem = doorProblem(d);
      if (problem != null) {
        skipped++;
        if (skipReason == null) skipReason = problem;
        continue;
      }
      final Map<String, Object> hg = (Map<String, Object>) d.get("hinge");
      final Map<String, Object> lf = (Map<String, Object>) d.get("leaf");
      out.add(new Door(
          (String) d.get("node"), (String) d.get("axis"),
          ((Number) d.get("openAngleDeg")).doubleValue(),
          ((Number) hg.get("x")).doubleValue(),
          hg.get("y") instanceof Number ? ((Number) hg.get("y")).doubleValue() : 0d,
          ((Number) hg.get("z")).doubleValue(),
          ((Number) lf.get("x0")).doubleValue(), ((Number) lf.get("x1")).doubleValue(),
          ((Number) lf.get("z0")).doubleValue(), ((Number) lf.get("z1")).doubleValue(),
          ((Number) d.get("swing")).doubleValue()));
    }
    return new DoorScan(List.copyOf(out), skipped, skipReason);
  }

  /** 只要可用的门（兼容旧调用）；需要知道跳过了几扇时用 {@link #planDoorScan}。 */
  public List<Door> planDoors(String id) {
    return planDoorScan(id).doors();
  }

  /** 型号数（写报告用） */
  public int size() {
    return raw.size();
  }

  /**
   * 目录里都有哪几款（运行时 id，有序）。
   *
   * 加这个方法是因为「**从未被使用的型号**」这个统计（R6-5 验收判据③）只能这么算：
   * 得先知道目录里有什么，再去方案里找谁用过它 —— 只给 `size()` 是数不出「少了哪几款」的。
   * 返回的是**不可变副本**，调用方拿它当快照用（本对象可能被 `CatalogSource` 换掉）。
   */
  public java.util.List<String> ids() {
    return java.util.List.copyOf(raw.keySet());
  }
}