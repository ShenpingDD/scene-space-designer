package com.scene.spatial.kernel;

import java.util.List;

/**
 * KernelMain.java —— 在 Java 侧跑一遍用例表（**不依赖 JUnit / Maven**）
 *
 * 为什么不是 JUnit：本机没有 Maven（拉不到依赖），但 JDK 有了 —— 内核是纯函数、零依赖，
 * 所以 `javac` + `java` 就能**真编译、真跑**。这不是"降级"，是刻意的取舍：
 * **语义正确性不该被构建工具绑架**。Spring 进来之后这个 main 依然有用（回归入口），
 * 到时装个 JUnit 壳子调 {@link CaseRunner} 即可，判据不用重写第二遍。
 *
 * 用法：
 * <pre>
 *   bash tools/server/run-java-kernel.sh          # 一条命令编译 + 跑（推荐）
 *   等价手写：javac -encoding UTF-8 -d out server/src/main/java/com/scene/spatial/kernel/*.java \
 *              server/src/main/java/com/scene/spatial/params/ParamsFingerprint.java
 *   java -Dstdout.encoding=UTF-8 -cp out com.scene.spatial.kernel.KernelMain
 * </pre>
 * 退出码：0 = 无失败（skip 不算失败）；1 = 有失败。
 */
public final class KernelMain {

  private KernelMain() {
  }

  public static void main(String[] args) {
    // 开发期用：把某条用例的布局导出成方案文本，便于与浏览器/Node 的输出做逐字节比对
    if (args.length >= 2 && "--export-case".equals(args[0])) {
      System.out.print(new CaseRunner(new Catalog(Cases.CATALOG)).exportOf(args[1]));
      return;
    }
    final Catalog catalog = new Catalog(Cases.CATALOG);
    final CaseRunner runner = new CaseRunner(catalog);
    final List<CaseRunner.Outcome> results = runner.runAll();

    int pass = 0;
    int fail = 0;
    int skip = 0;
    System.out.println("用例表 v" + Cases.VERSION + " · Java 侧复现（共 " + Cases.ALL.size() + " 条）");
    System.out.println("型号目录：" + catalog.size() + " 个型号");
    System.out.println();
    for (final CaseRunner.Outcome r : results) {
      final String mark = switch (r.status()) {
        case "pass" -> "PASS";
        case "fail" -> "FAIL";
        default -> "SKIP";
      };
      switch (r.status()) {
        case "pass" -> pass++;
        case "fail" -> fail++;
        default -> skip++;
      }
      System.out.printf("%-4s %-36s %s%n", mark, r.id(), r.rule());
      for (final String m : r.mismatches()) {
        System.out.println("       " + m);
      }
    }
    System.out.println();
    System.out.printf("合计：%d 通过 / %d 失败 / %d 未移植    (JDK %s)%n",
        pass, fail, skip, System.getProperty("java.version"));
    if (fail > 0) {
      System.out.println("结论：**不通过** —— 同一份用例表，Java 与 JS 结论不一致，必须查清是哪边错了。");
      System.exit(1);
    }
    System.out.println("结论：已移植的规则与用例表**逐条同结论**（服务端是唯一裁判，这一条守住了）。");
  }
}