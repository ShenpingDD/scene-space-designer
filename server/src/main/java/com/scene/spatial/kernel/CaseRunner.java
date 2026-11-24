package com.scene.spatial.kernel;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * CaseRunner.java —— 用例表执行器（Java 侧）
 *
 * 对应 `spatial-core/src/case-runner.js`：语义、比较口径、期望值来源都照它。
 *
 * 为什么要有这一份：用例表是**语言中立**的（输入 → 期望结论）。浏览器里跑它，是证明界面用的
 * 就是被断言的规则；Java 跑它，是证明"**服务端是唯一裁判**" —— 同一份判据、同一份期望值，
 * 两边结论不一致，就是有人把规则改歪了。
 *
 * 比较口径对齐 JS 的 `JSON.stringify`：数字**按数值比**（`106` 与 `106.0` 相同，与 JS 一致 ——
 * 这条很关键，否则 Java 的 `Integer`/`Double` 装箱差异会造出一堆假失败），
 * 列表逐元素递归、对象逐键递归。
 */
public final class CaseRunner {

  /**
   * 一条用例的结果。
   * `status`：`pass` / `fail` / `skip` —— 未移植的规则标 `skip`，
   * **不算失败**（否则"没做"会被误读成"做错了"，掩盖真正的回归）。
   */
  public record Outcome(String id, String rule, String why, String status,
                        List<String> mismatches, Map<String, Object> actual) {
  }

  private final Catalog catalog;

  public CaseRunner(Catalog catalog) {
    this.catalog = catalog;
  }

  // ── 用例表 → 领域模型 ────────────────────────────────────────────────
  @SuppressWarnings("unchecked")
  private static Map<String, Object> map(Object o) {
    return o instanceof Map ? (Map<String, Object>) o : Map.of();
  }

  @SuppressWarnings("unchecked")
  private static List<Object> list(Object o) {
    return o instanceof List ? (List<Object>) o : List.of();
  }

  private static double num(Object o) {
    return o instanceof Number ? ((Number) o).doubleValue() : 0d;
  }

  private static Layout layoutOf(Map<String, Object> c) {
    final Map<String, Object> room = map(c.get("room"));
    final Layout layout = new Layout(num(room.get("w")), num(room.get("d")),
        room.containsKey("h") ? num(room.get("h")) : 2.8);  // 用例里常省略 h，按 2.8（与 JS 布局构造一致）
    // 墙：用例表里写的是对象（W1 起）；宽容读法（`Scheme.wallOf` 是私有的，这里用同一套形状判断）
    for (final Object w : list(c.get("walls"))) layout.walls.add(wallOfCase(w));
    for (final Object i : list(c.get("items"))) layout.items.add(itemOf(map(i)));
    final Map<String, Object> view = map(c.get("view"));
    layout.wallStyle = (String) view.get("wallOpacity");
    // 房间名（M1a）：与 JS `case-runner.js` 同一读法（只收字符串值、空名字丢掉 ——
    // 与 `Scheme.stateOf` 的写出面同一口径，两边导出的字节才能逐字节相同）。
    for (final Map.Entry<String, Object> e : map(c.get("roomLabels")).entrySet()) {
      final String name = Scheme.readRoomLabel(e.getValue());
      if (!name.isEmpty()) layout.roomLabels.put(e.getKey(), name);
    }
    return layout;
  }

  /** 用例表里的一面墙 → 领域对象（对象形状；老式四数数组也宽容读） */
  private static Wall wallOfCase(Object o) {
    if (o instanceof List<?> list) {
      return Wall.of(num(list.get(0)), num(list.get(1)), num(list.get(2)), num(list.get(3)));
    }
    final Map<String, Object> m = map(o);
    final List<Object> a = list(m.get("a"));
    final List<Object> b = list(m.get("b"));
    final Wall w = Wall.of(num(a.get(0)), num(a.get(1)), num(b.get(0)), num(b.get(1)));
    // W3 角色：与 `Scheme.wallOf` 同一条**宽容读**（缺省/认不得 → null = 当没写）。
    // 手抄一个 `if` 在这里，就会让「用例夹具里有 role、服务端读不到」变成假绿 ——
    // 与门洞那次（窗降级成门）完全同一种坑。
    w.role = Wall.readRole(m.get("role"));
    final List<Wall.Opening> openings = new ArrayList<>();
    for (final Object oo : list(m.get("openings"))) {
      final Map<String, Object> om = map(oo);
      // ⚠️ 走与 `Scheme` 同一条宽容读：手抄 `at/w/h` 会让**用例夹具里的窗降级成门** ——
      //    而这只在服务端跑用例时发生。这一处就是被 `collision-window-blocks` 与
      //    `room-resize-window-kept` 两条用例当场抓出来的（用例表按设计起了作用）。
      if (Wall.WINDOW.equals(om.get("kind"))) {
        openings.add(new Wall.Opening(num(om.get("at")), num(om.get("w")), num(om.get("h")),
            Wall.WINDOW, num(om.get("sill"))));
      } else {
        openings.add(new Wall.Opening(num(om.get("at")), num(om.get("w")), num(om.get("h"))));
      }
    }
    return openings.isEmpty() ? w : w.withOpenings(openings);
  }

  private static Layout.Item itemOf(Map<String, Object> m) {
    return new Layout.Item(
        (int) num(m.get("id")), (String) m.get("p"),
        num(m.get("x")), num(m.get("z")), num(m.get("r")),
        m.containsKey("doorAmount") ? num(m.get("doorAmount")) : 0);
  }

  // ── 比较 ────────────────────────────────────────────────────────────
  @SuppressWarnings("unchecked")
  static boolean same(Object a, Object b) {
    if (a == null || b == null) return a == b;
    if (a instanceof Number && b instanceof Number) return ((Number) a).doubleValue() == ((Number) b).doubleValue();
    if (a instanceof List && b instanceof List) {
      final List<Object> la = (List<Object>) a;
      final List<Object> lb = (List<Object>) b;
      if (la.size() != lb.size()) return false;
      for (int i = 0; i < la.size(); i++) {
        if (!same(la.get(i), lb.get(i))) return false;
      }
      return true;
    }
    if (a instanceof Map && b instanceof Map) {
      final Map<String, Object> ma = (Map<String, Object>) a;
      final Map<String, Object> mb = (Map<String, Object>) b;
      if (!ma.keySet().equals(mb.keySet())) return false;
      for (final String k : ma.keySet()) {
        if (!same(ma.get(k), mb.get(k))) return false;
      }
      return true;
    }
    return a.equals(b);
  }

  // ── 各组规则的运行器（返回 null = 该规则尚未移植）──────────────────────
  private Map<String, Object> runRule(String rule, Map<String, Object> c) {
    final Map<String, Object> out = new LinkedHashMap<>();
    switch (rule) {
      case "validate": {
        final Layout body = layoutOf(c);
        final Layout.Item item = itemOf(map(c.get("item")));
        final List<Layout.Item> others = new ArrayList<>();
        for (final Layout.Item it : body.items) {
          if (it.id != item.id) others.add(it);
        }
        body.items.clear();
        body.items.addAll(others);
        out.put("reason", Validate.checkItem(body, item, catalog));
        break;
      }
      case "validate-wall": {
        // 墙越界（B19）。注意 Validate.badWalls() 只回**序号**（给 Audit 数数用），
        // 用例表要的是 {index, reason} 的清单 —— 所以这里逐面调 checkWall 自己拼，
        // 而不是把一个只能数数的接口改成两用（同一个名字表示两种意思，D40 刚吃过亏）。
        final Layout body = layoutOf(c);
        final java.util.List<Object> bad = new java.util.ArrayList<>();
        for (int i = 0; i < body.walls.size(); i++) {
          final String reason = Validate.checkWall(body, body.walls.get(i));
          if (reason == null) continue;
          final Map<String, Object> row = new LinkedHashMap<>();
          row.put("index", i);
          row.put("reason", reason);
          bad.add(row);
        }
        out.put("badWalls", bad);
        break;
      }
      case "room-resize": {
        final Map<String, Object> next = map(c.get("next"));
        final Room.Apply r = Room.applyRoomSize(layoutOf(c),
            num(next.get("w")), num(next.get("d")), num(next.get("h")));
        if (!r.ok()) {
          out.put("ok", false);
          out.put("error", r.error());
          break;
        }
        out.put("ok", true);
        out.put("kept", r.kept());
        out.put("removed", r.removed());
        out.put("wallCount", r.layout().walls.size());
        out.put("firstWall", Scheme.wallJson(r.layout().walls.get(0)));
        // 门洞读数（W1）：跟走了几个 / 放不下删了几个 —— 与 JS `case-runner.js` 同名字同口径
        out.put("openingsKept", r.openingsKept());
        out.put("openingsDropped", r.openingsDropped());
        // 窗读数（W2）：与 JS `case-runner.js` 同名同口径 —— 钉住「改房间尺寸不许把窗降级成落地洞」
        int windowCount = 0;
        for (final Wall w : r.layout().walls) windowCount += w.windowOpenings().size();
        out.put("windowCount", windowCount);
        break;
      }
      case "door-clearance": {
        final Layout body = layoutOf(c);
        final int id = (int) num(map(c.get("item")).get("id"));
        Layout.Item subject = null;
        for (final Layout.Item it : body.items) {
          if (it.id == id) subject = it;
        }
        if (subject == null) {
          out.put("error", "用例里没有 id=" + id + " 的设备");
          break;
        }
        final Clearance.Result r = Clearance.doorFreeAngle(body, subject, catalog);
        out.put("freeDeg", r.freeDeg());
        out.put("maxDeg", r.maxDeg());
        out.put("level", Clearance.clearanceLevel(r.freeDeg()));
        out.put("unobstructed", r.unobstructed());
        out.put("door", r.door());
        out.put("blockedKind", r.blockedBy() == null ? null : r.blockedBy().kind());
        out.put("blockedId", r.blockedBy() == null ? null : r.blockedBy().id());
        break;
      }
      case "placement": {
        final Layout body = layoutOf(c);
        final String product = (String) c.get("product");
        final int fillTo = c.get("fillTo") instanceof Number ? (int) num(c.get("fillTo")) : 0;
        for (int i = 0; i < fillTo; i++) {
          final Placement.Result s = Placement.addItem(body, product, catalog, null, null, null);
          if (!s.ok()) {
            out.put("ok", false);
            out.put("reason", s.reason());
            out.put("filled", i);
            return out;
          }
        }
        final Placement.Result r = Placement.addItem(body, product, catalog, null, null, null);
        if (r.ok()) {
          out.put("ok", true);
          out.put("x", r.item().x);
          out.put("z", r.item().z);
        } else {
          out.put("ok", false);
          out.put("reason", r.reason());
        }
        break;
      }
      case "scheme-roundtrip": {
        final String before = Scheme.exportScheme(layoutOf(c));
        final Scheme.ImportResult r = Scheme.importScheme(before, catalog, true);
        if (!r.ok()) {
          out.put("ok", false);
          out.put("reason", r.error().reason());
          break;
        }
        out.put("ok", true);
        out.put("identical", Scheme.exportScheme(r.layout()).equals(before));
        out.put("styleOut", r.layout().wallStyle);
        // 门洞数（W1）：`stateOf` 是字段白名单，漏一个字段就会在保存/分享/交付链上
        // 无警告消失 —— 这条读数就是那条判据的机器形状（与 JS `case-runner.js` 同名同口径）
        int openingCount = 0;
        for (final Wall w : r.layout().walls) openingCount += w.openings.size();
        out.put("openingCount", openingCount);
        // 房间名数（M1a）：`stateOf` 是字段白名单，漏一个字段就会在保存/分享/交付链上
        // 无警告消失 —— 与 `openingCount` 同一形状的判据（与 JS `case-runner.js` 同名同口径）
        out.put("roomLabelCount", r.layout().roomLabels.size());
        out.put("nextId", r.nextId());
        out.put("format", r.format());
        break;
      }
      case "scheme-accept": {
        boolean allOk = true;
        for (final Object f : list(c.get("formats"))) {
          allOk = allOk && Scheme.importScheme(Scheme.sampleDoc((String) f, new Layout(8, 6, 2.8)), catalog, true).ok();
        }
        out.put("allOk", allOk);
        break;
      }
      case "scheme-errors": {
        boolean exact = true;
        for (final Object o : list(c.get("samples"))) {
          final Map<String, Object> s = map(o);
          final String kind = (String) s.get("bad");
          final String want = (String) s.get("reason");
          final Scheme.ImportResult r = Scheme.importScheme(badSample(kind), catalog, true);
          final String got = r.ok() ? "ok" : r.error().reason();
          if (!got.equals(want)) {
            exact = false;
            out.put("firstMismatch", kind + " → " + got + "（期望 " + want + "）");
          }
        }
        out.put("exact", exact);
        break;
      }
      case "door": {
        final Map<String, Object> hg = map(c.get("hinge"));
        out.put("rotation", Doors.hingeRotation((String) hg.get("axis"),
            num(hg.get("openAngle")), num(c.get("amount"))));
        break;
      }
      case "collision": {
        final Layout body = layoutOf(c);
        final List<Object> pt = list(c.get("point"));
        out.put("blocked", Collision.blocked(num(pt.get(0)), num(pt.get(1)), body, catalog));
        break;
      }
      case "collision-spawn": {
        final Layout body = layoutOf(c);
        final double[] sp = Collision.safeSpawn(body, catalog, List.of());
        out.put("spawnIsFree", sp != null && !Collision.blocked(sp[0], sp[1], body, catalog));
        break;
      }
      default:
        return null;
    }
    return out;
  }

  /**
   * `scheme-errors` 的 6 类坏样本（与 JS 侧逐条对齐）：
   * 坏 JSON / 格式不符 / 房间超范围 / 墙太多 / 编号重复 / 墙不合法。
   */
  private static Object badSample(String kind) {
    final String f = Scheme.FORMAT;
    switch (kind) {
      case "not-json":
        return "{oops";
      case "bad-format":
        return Json.obj("format", "other", "state", Json.obj());
      case "bad-room":
        return Json.obj("format", f, "state", Json.obj("w", 99, "d", 6, "h", 2.8,
            "walls", Json.arr(), "items", Json.arr()));
      case "too-many-walls": {
        final List<Object> walls = new ArrayList<>();
        for (int i = 0; i < 101; i++) walls.add(Json.arr(0, 0, 1, 0));
        return Json.obj("format", f, "state", Json.obj("w", 8, "d", 6, "h", 2.8,
            "walls", walls, "items", Json.arr()));
      }
      case "duplicate-id":
        return Json.obj("format", f, "state", Json.obj("w", 8, "d", 6, "h", 2.8, "walls", Json.arr(),
            "items", Json.arr(
                Json.obj("id", 1, "p", "demo-cabinet-800", "x", 1, "z", 1, "r", 0),
                Json.obj("id", 1, "p", "demo-cabinet-800", "x", 4, "z", 1, "r", 0))));
      case "bad-wall":
        return Json.obj("format", f, "state", Json.obj("w", 8, "d", 6, "h", 2.8,
            // 斜墙合法之后 [0,0,8,3] 不再是坏墙 → 换成「太短」（与 JS 同一份样本）
            "walls", Json.arr(Json.arr(0, 0, 0.05, 0)), "items", Json.arr()));
      default:
        return Json.obj();
    }
  }

  /** 按用例 id 导出方案文本（开发期核对：服务端生成的文件与浏览器生成的是否逐字节相同） */
  public String exportOf(String caseId) {
    for (final Object o : Cases.ALL) {
      final Map<String, Object> c = map(o);
      if (caseId.equals(c.get("id"))) return Scheme.exportScheme(layoutOf(c));
    }
    return null;
  }

  public List<Outcome> runAll() {
    final List<Outcome> out = new ArrayList<>();
    for (final Object o : Cases.ALL) out.add(run(map(o)));
    // ⭐ 表外的一条契约：真目录里每一款都得有人用过（见 coverage 的注释）
    out.add(coverage());
    return out;
  }

  /**
   * ⭐ 目录覆盖：**两个方向都管**——
   *
   *   ① 目录里每一款都必须至少被一条用例用过（`unusedIds`）；
   *   ② 用例里提到的每一个型号都必须在目录里（`unknownIds`）。
   *
   * 它不是一条「用例」，是用例表与**真实目录**之间的契约 —— 两边任一头变了都要立刻看得见。
   *
   * 为什么必须有 ②：`door-clearance` 对**未知型号**和对**上盖（axis=x）**返回的是同一种结论
   * （`freeDeg=null` / `level=n/a`）—— 所以某款从目录里消失时，用它的那条用例**可能静默通过**，
   * 而「没报错」看起来就像「没事」。方向 ② 把这件事变成一个响亮的名字。（写这条测试时实测撞到。）
   *
   * 口径：只认用例的**输入**里出现过的 id（`items[].p` / `product`）——
   * 期望值里写到的 id 不算“用过”（那只是对答案）。
   *
   * ⚠️ 两个方向的**重量不一样**（2026-11-23 收紧）：
   *   ① `unusedIds`（目录新加了一款、用例还没覆盖）→ **warn**：这是欠的账，要看得见，但产品本身是好的，
   *      不该把整张用例表判成 fail（否则每加一款演示产品都红一片，红久了就没人看）；
   *   ② `unknownIds`（用例提到目录里没有的型号）→ **fail**：用例在为一个不存在的产品背书，
   *      而且未知型号可能让用例**静默通过**（见上），必须挡住。
   */
  public Outcome coverage() {
    final java.util.Set<String> used = new java.util.TreeSet<>();
    for (final Object o : Cases.ALL) {
      final Map<String, Object> c = map(o);
      collectId(c.get("product"), used);
      collectIds(c.get("items"), used);
      collectIds(c.get("item"), used);
    }
    final List<String> all = new ArrayList<>(catalog.ids());
    java.util.Collections.sort(all);
    final List<String> unused = new ArrayList<>();
    for (final String id : all) {
      if (!used.contains(id)) unused.add(id);
    }
    final List<String> unknown = new ArrayList<>();
    for (final String id : used) {
      if (!all.contains(id)) unknown.add(id);
    }
    final Map<String, Object> actual = new LinkedHashMap<>();
    actual.put("catalogSize", all.size());
    actual.put("catalogIds", all);
    actual.put("usedIds", new ArrayList<>(used));
    actual.put("unusedIds", unused);
    actual.put("unknownIds", unknown);
    final List<String> problems = new ArrayList<>();
    if (!unused.isEmpty()) problems.add("目录里有、却没有任何用例用过（warn：欠的账，不挡用例表）："
        + String.join("、", unused));
    if (!unknown.isEmpty()) problems.add("用例提到了、目录里却没有（fail：在为一个不存在的型号背书）："
        + String.join("、", unknown));
    // 分层：unknown 直接 fail；只有 unused 时 warn（不是 pass —— 欠账要看得见）
    final String status = !unknown.isEmpty() ? "fail" : (!unused.isEmpty() ? "warn" : "pass");
    return new Outcome("catalog-coverage-every-product-used", "catalog",
        "用例表与目录两头对齐：目录每一款都被用过（warn），用例提到的每一款都在目录里（fail）",
        status, problems, actual);
  }

  private static void collectId(Object v, java.util.Set<String> into) {
    if (v instanceof String s && !s.isBlank()) into.add(s);
  }

  private static void collectIds(Object v, java.util.Set<String> into) {
    if (v instanceof Map<?, ?> one) collectId(one.get("p"), into);
    if (v instanceof List<?> list) {
      for (final Object o : list) {
        if (o instanceof Map<?, ?> m) collectId(m.get("p"), into);
      }
    }
  }

  public Outcome run(Map<String, Object> c) {
    final String id = (String) c.get("id");
    final String rule = (String) c.get("rule");
    final String why = c.get("why") == null ? "" : (String) c.get("why");

    Map<String, Object> actual;
    try {
      actual = runRule(rule, c);
    } catch (RuntimeException e) {
      actual = Map.of("error", String.valueOf(e));
      return new Outcome(id, rule, why, "fail", List.of("抛错：" + e), actual);
    }
    if (actual == null) {
      return new Outcome(id, rule, why, "skip", List.of("规则 " + rule + " 尚未移植到 Java"), null);
    }

    final List<String> mismatches = new ArrayList<>();
    for (final Map.Entry<String, Object> e : map(c.get("expect")).entrySet()) {
      final Object got = actual.get(e.getKey());
      if (!same(got, e.getValue())) {
        mismatches.add(e.getKey() + "：期望 " + e.getValue() + "，实际 " + got);
      }
    }
    return new Outcome(id, rule, why, mismatches.isEmpty() ? "pass" : "fail", mismatches, actual);
  }
}