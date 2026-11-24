package com.scene.spatial.kernel;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * CasesAllGreenTest —— **整张用例表当作一条断言**（Java 侧）。
 *
 * ## 为什么要有它（这一条是被一次变异验证逼出来的）
 *
 * W1 门洞做完之后做变异验证：把 `Scheme.stateOf` 改成**不发射门洞**（也就是复现 FIX-05
 * 「导出即丢数据」），预期用例 `scheme-roundtrip-openings` 变红 —— 结果 `mvn test` **全绿** ✗。
 * 查下去发现：Java 侧只有 `CaseCoverageTest`（管"目录覆盖契约"），
 * **没有任何一条测试把用例表的期望值当断言跑** —— 那张表只在**运行时**
 * （`/api/health/kernel` 与 `start.sh --status`）被核对。
 *
 * "只在运行时核对"就是"平时不会红"：谁改坏了 Java 内核，本地测试照样全绿，
 * 一直到谁重启一次服务才看得见 —— 而那时候人已经在想别的事了。
 *
 * ## 它管什么
 *
 * `CaseRunner.runAll()` = 41 条用例 + 1 条覆盖契约（共 42 条），逐条与期望值比对：
 * 任何一条 `status != pass` 都要点名（id + 具体的期望/实际差异）。
 *
 * 与 JS 侧的关系：`spatial-core/test/cases.test.js` 用**同一张表**跑 JS 内核。
 * 两张网缺一不可 —— 只有一侧有断言，就等于另一侧的漂移没人管。
 */
class CasesAllGreenTest {

  @Test
  @DisplayName("整张用例表在服务端全绿（47 条用例 + 覆盖契约）")
  void allCasesPass() {
    final CaseRunner runner = new CaseRunner(new Catalog(Cases.CATALOG));
    final List<CaseRunner.Outcome> all = runner.runAll();
    final List<String> bad = new ArrayList<>();
    for (final CaseRunner.Outcome o : all) {
      if (!"pass".equals(o.status())) bad.add(o.id() + " → " + o.mismatches());
    }
    assertTrue(bad.isEmpty(), "服务端与用例表对不上（" + bad.size() + " 条）：" + bad);
  }

  @Test
  @DisplayName("用例表条数 = 47（表变了要显式改这里，不许悄悄少跑）")
  void caseCountIsPinned() {
    // 少一条也用 "assertTrue(bad.isEmpty())" 那种写法看不出来 —— 条数必须自己钉一遍
    // ⚠️ 这个钉子钉的是**生成物** `Cases.java`，不是真源 `rules.json` —— 生成物落后时它是绿的
    //（M1 就踩过：表已 v9/37 条，Cases.java 还是 v7/35 条，这条照样通过）。
    // 真源那一侧由 `GeneratedDataFreshnessTest` 守（比对来源 sha）。两条缺一不可。
    assertTrue(Cases.ALL.size() == 47, "用例表条数变了：" + Cases.ALL.size() + "（Cases.java 要重新生成）");
  }
}