package com.scene.spatial.kernel;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * CaseCoverageTest —— **覆盖契约自己也要有断言**
 *
 * 「目录里每一款都被用例用过」这条契约（`CaseRunner.coverage()`）如果只会绿，它就是假的。
 * 一个永远绿的检查器比没有更坏：它会让人以为"加产品漏测"这种事已经被挡住了 —— 其实没有。
 *
 * 所以这里做两件事：
 *   ① 拿**真目录**（退路夹具那份，4 款）跑 → 必须 pass（现状：4 款都有人用过）；
 *   ② 拿一份**多出一款没人用过**的目录跑 → 必须 fail，而且要点名是哪一款。
 *      ⚠️ 用假型号，不往真目录里塞东西（这条测试不该动任何数据）。
 */
class CaseCoverageTest {

  @Test
  @DisplayName("真目录（退路夹具）· 每一款都被用过 → 契约通过")
  void realCatalogIsFullyCovered() {
    final CaseRunner.Outcome o = new CaseRunner(new Catalog(Cases.CATALOG)).coverage();
    assertEquals("pass", o.status(), "有型号没被任何用例用过：" + o.actual().get("unusedIds"));
    assertEquals(4, o.actual().get("catalogSize"), "退路目录现在是 4 款（demo-cabinet-800/demo-freezer-dual/demo-freezer-upright/demo-freezer-chest）");
  }

  @Test
  @DisplayName("⭐ 多一款没人用过 → warn（欠账要看得见），但不是 fail")
  void unusedProductMustWarn() {
    final Map<String, Object> raw = new LinkedHashMap<>(Cases.CATALOG);
    raw.put("fictional-new-product", Map.of("w", 1.0, "d", 1.0));
    final CaseRunner.Outcome o = new CaseRunner(new Catalog(raw)).coverage();
    // 2026-11-23 收紧口径：目录新加产品是**欠的账**（warn），不该把整张用例表判红；
    // 但也不许悄悄 pass —— 那会让「加产品漏测」永远看不见。
    assertEquals("warn", o.status());
    assertEquals(List.of("fictional-new-product"), o.actual().get("unusedIds"));
    assertTrue(o.mismatches().get(0).contains("fictional-new-product"),
        "警告话里要点名是哪一款：" + o.mismatches());
    assertTrue(o.mismatches().get(0).contains("warn"), "要说清这是 warn 还是 fail：" + o.mismatches());
  }

  @Test
  @DisplayName("⭐ 某款从目录里消失（用例还在用它）→ fail：它变成 `unknownIds`")
  void disappearedProductAlsoShows() {
    final Map<String, Object> raw = new LinkedHashMap<>(Cases.CATALOG);
    raw.remove("demo-freezer-chest");
    final CaseRunner runner = new CaseRunner(new Catalog(raw));
    final CaseRunner.Outcome o = runner.coverage();
    assertEquals("fail", o.status());
    assertEquals(List.of("demo-freezer-chest"), o.actual().get("unknownIds"));
    // 顺带钉下一个**实测到的洞**：用它的那条用例（上盖不进平面）**自己不会红** ——
    // `door-clearance` 对未知型号和对上盖给的是同一种结论（freeDeg=null / level=n/a）。
    // 所以「删除」这件事只有方向 ② 看得见；谁说“用例会抓住”谁就错了。
    final CaseRunner.Outcome lid = runner.runAll().stream()
        .filter((x) -> "door-clearance-lid-not-in-plan".equals(x.id())).findFirst().orElseThrow();
    assertEquals("pass", lid.status(), "（这是已知边界：这条用例自己看不出型号没了）");
  }
}