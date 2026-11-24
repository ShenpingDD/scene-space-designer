package com.scene.spatial.audit;

import com.scene.spatial.catalog.CatalogSource;
import com.scene.spatial.kernel.Audit;
import com.scene.spatial.kernel.Cases;
import com.scene.spatial.kernel.Catalog;
import com.scene.spatial.kernel.Json;
import com.scene.spatial.kernel.Layout;
import com.scene.spatial.kernel.Params;
import com.scene.spatial.kernel.Scheme;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * AuditServiceTest —— R4-3 体检接口
 *
 * 钉两件事：
 * ① **体检的语义**：`clean` 只说"摆得合规"，`trouble` 才说"用不用得上" —— 这两句必须分开，
 *    否则用户会以为全绿就等于没问题（设计决策记录实测过：合法性问题 0，门只能开 22°）。
 * ② **缓存的承诺**：同一布局必须命中、改一点必须不命中、参数一改自动作废、满了要淘汰。
 *    缓存这类东西出错是**静默**的 —— 所以每一条承诺都值得一条断言（设计决策记录判据⑤）。
 *
 * 这里不重复用例表：规则 7 的角度本身由 `run-java-kernel.sh` 那 22 条与浏览器逐条对齐，
 * 本文件管的是"报告的形状与缓存的账"。
 */
class AuditServiceTest {

  private static final Catalog CATALOG = new Catalog(Cases.CATALOG);

  /** 合法但门打不开的一对：两台相隔 0.37 m，柜体不重叠（checkItem 为 null），但门只能开一点点 */
  private static Map<String, Object> pair() {
    return Json.obj("w", 8, "d", 6, "h", 2.8, "walls", Json.arr(), "items", Json.arr(
        Json.obj("id", 1, "p", "demo-cabinet-800", "x", 2, "z", 2, "r", 0, "doorAmount", 0),
        Json.obj("id", 2, "p", "demo-freezer-dual", "x", 2, "z", 3.35, "r", 0, "doorAmount", 0)));
  }

  /** 直接过内核拿到布局：与接口层同一条路（体检算的就是这条路上的东西） */
  private static Layout layoutOf(Map<String, Object> state) {
    final Scheme.ImportResult r = Scheme.importScheme(
        Json.obj("format", Scheme.FORMAT, "state", state), CATALOG, true);
    if (!r.ok()) throw new IllegalStateException(r.error().reason() + " " + r.error().message());
    return r.layout();
  }

  private static Audit.DoorRow row(Audit.Report r, int id) {
    return r.doorRows().stream().filter(x -> x.id() == id).findFirst().orElseThrow();
  }

  @Test
  void 合法但门打不开时_clean与trouble必须能同时成立() {
    final Audit.Report r = Audit.of(layoutOf(pair()), CATALOG);
    assertEquals(2, r.items());
    assertEquals(0, r.issues(), "占地本身必须合法（不越界/不重叠/不压墙）");
    assertTrue(r.clean(), "摆得合规");
    assertEquals(1, r.trouble(), "但有一台的门开不到绿灯阈值 —— 这两句必须能同时成立");
    final Audit.DoorRow bad = row(r, 1);
    assertEquals("bad", bad.level());
    assertFalse(bad.unobstructed());
    assertNotNull(bad.blockedBy());
    assertEquals("item", bad.blockedBy().kind());
    assertEquals(2, bad.blockedBy().id(), "被 #2 挡住（不是被房间边界）");
    assertTrue(bad.freeDeg() > 0 && bad.freeDeg() < Params.doorOpenOkDeg, "角度 " + bad.freeDeg());
    assertEquals(2, r.doors());
  }

  @Test
  void 报告只给事实_字段够界面说话但服务端不复制用户话术() {
    final Map<String, Object> json = Audit.json(Audit.of(layoutOf(pair()), CATALOG));
    assertTrue(json.containsKey("trouble"));
    assertTrue(json.containsKey("clean"));
    assertTrue(json.containsKey("doorRows"));
    final Map<String, Object> sum = Audit.summary(Audit.of(layoutOf(pair()), CATALOG));
    // ⚠️ 这条断言原来钉的是「四个数」。B19 加了 `wallIssues`（墙摆得不对的面数）→ 五个。
    //    这里**不是**把数字改大就完事：这条测试真正要保的是「列表页不拖明细」。
    //    所以除了数字，还把「三张明细表一个都不许出现」也钉上 —— 只改数字的话，
    //    哪天有人把 issueRows 塞进 summary，这条测试照样绿。
    assertEquals(5, sum.size(), "列表只要 items/issues/wallIssues/trouble/clean 五个数，不拖明细");
    assertFalse(sum.containsKey("issueRows"), "明细行不许进列表摘要");
    assertFalse(sum.containsKey("doorRows"));
    assertFalse(sum.containsKey("wallRows"));
  }

  @Test
  void 缓存_同一布局第二次必须命中_改一台必须不命中() {
    final AuditService svc = new AuditService(new CatalogSource(CATALOG), 128, 600);

    final Map<String, Object> first = svc.check(pair());
    assertEquals(Boolean.FALSE, first.get("cached"), "第一次必然是冷的");
    assertTrue(((Number) first.get("costMs")).longValue() >= 0);

    final Map<String, Object> second = svc.check(pair());
    assertEquals(Boolean.TRUE, second.get("cached"), "同样的布局必须命中 —— 命不中就白算了");
    assertEquals(0L, ((Number) second.get("costMs")).longValue());

    final Map<String, Object> moved = Json.obj("w", 8, "d", 6, "h", 2.8, "walls", Json.arr(), "items", Json.arr(
        Json.obj("id", 1, "p", "demo-cabinet-800", "x", 2, "z", 2, "r", 0, "doorAmount", 0),
        Json.obj("id", 2, "p", "demo-freezer-dual", "x", 2, "z", 5.35, "r", 0, "doorAmount", 0)));
    assertEquals(Boolean.FALSE, svc.check(moved).get("cached"), "挪了一台就是另一个布局，绝不能吃旧结论");

    final Map<String, Object> stats = svc.stats();
    assertEquals(1L, stats.get("hits"));
    assertEquals(2L, stats.get("misses"));
  }

  @Test
  void 缓存键与字典顺序无关_换个键序照样命中() {
    final AuditService svc = new AuditService(new CatalogSource(CATALOG), 128, 600);
    svc.check(pair());
    // 同样的内容、不同的书写顺序：规范化之后是同一份布局
    final Map<String, Object> reordered = Json.obj("items", Json.arr(
        Json.obj("id", 1, "p", "demo-cabinet-800", "x", 2, "z", 2, "r", 0, "doorAmount", 0),
        Json.obj("id", 2, "p", "demo-freezer-dual", "x", 2, "z", 3.35, "r", 0, "doorAmount", 0)),
        "walls", Json.arr(), "h", 2.8, "d", 6, "w", 8);
    assertEquals(Boolean.TRUE, svc.check(reordered).get("cached"),
        "键按内容算，不按 JSON 文本算 —— 否则 MySQL 的 JSON 列换个键序就永远命中不了");
  }

  @Test
  void 缓存满了要淘汰_而且淘汰要记在账上() {
    final AuditCache cache = new AuditCache(1, 600);
    final Audit.Report dummy = new Audit.Report(0, 0, 0, 0, 0, 0, true, List.of(), List.of(), List.of());
    cache.getOrCompute("a", () -> dummy);
    cache.getOrCompute("b", () -> dummy);
    final Map<String, Object> stats = cache.stats();
    assertEquals(1, stats.get("size"));
    assertEquals(1L, stats.get("evictions"), "淘汰必须可见 —— 静默淘汰会表现成'命中率莫名其妙很低'");
    assertEquals(2L, stats.get("misses"));
    assertEquals(0L, stats.get("hits"));
  }
}