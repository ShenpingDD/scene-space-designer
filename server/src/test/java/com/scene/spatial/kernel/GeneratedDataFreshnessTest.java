package com.scene.spatial.kernel;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * GeneratedDataFreshnessTest —— 生成物**落后于真源**这件事必须响亮。
 *
 * ## 为什么要有它（被 M1 多房间当场逼出来的）
 *
 * `Cases.java` / `Params.java` 是 `tools/server/gen-java-data.mjs` 从
 * `spatial-core/test/cases/rules.json` 与 `config/params.default.json` 生成的，
 * 生成器还会把来源的 sha256（前 16 位）写进生成物文件头 —— 本来是为了"谁都能核"。
 *
 * 但 M1 收尾时它骗过了所有人：`rules.json` 已经升到 v9/37 条，`Cases.java` 还停在 v7/35 条，
 * 而 **Java 侧全绿**：
 *   · `CasesAllGreenTest` 只跑它手上那张表 —— **缺的那条用例它根本看不见**；
 *   · `CasesAllGreenTest.caseCountIsPinned` 钉的是 `Cases.ALL.size()`，也就是**生成物自己**，
 *     生成物落后它就一起落后（"钉子钉在会漂的那一边"）；
 *   · `/api/health/kernel` 也只是把生成物里的表跑一遍。
 * 于是"服务端与用例表逐条同结论"这句话，**在生成物落后的那一整天里都是假的**。
 *
 * ## 它管什么
 *
 * 把生成物文件头记的 sha 与**真源现在的 sha** 对上。忘了重跑生成器 → 立刻红。
 *
 * 变异验证：改一个字节的 `rules.json`（或 `params.default.json`）而不重跑生成器 → 本条红。
 */
class GeneratedDataFreshnessTest {

  private static final String DIR = "src/main/java/com/scene/spatial/kernel/";

  /** 来源文件的 sha256 前 16 位（与生成器同一算法、同一截断：`tools/server/gen-java-data.mjs` 的 `sha()`） */
  private static String sha16(Path p) throws IOException {
    try {
      final MessageDigest md = MessageDigest.getInstance("SHA-256");
      final byte[] d = md.digest(Files.readAllBytes(p));
      final StringBuilder sb = new StringBuilder();
      for (int i = 0; i < 8; i++) sb.append(String.format("%02x", d[i]));
      return sb.toString();
    } catch (RuntimeException | java.security.NoSuchAlgorithmException e) {
      throw new IOException(e);
    }
  }

  /** 从生成物文件头那几行里把 sha 抠出来（文件头长这样：`来源：… sha256(前16)=abcdef0123456789`） */
  private static String recordedSha(String javaFile, String marker) throws IOException {
    final List<String> lines = Files.readAllLines(Path.of(DIR + javaFile));
    for (final String line : lines) {
      final int at = line.indexOf(marker);
      if (at < 0) continue;
      final Matcher m = Pattern.compile("([0-9a-f]{16})").matcher(line.substring(at));
      if (m.find()) return m.group(1);
    }
    return null;
  }

  @Test
  @DisplayName("Cases.java 不落后于用例表（来源 sha 与真源一致）")
  void casesAreFresh() throws IOException {
    final String recorded = recordedSha("Cases.java", "rules.json");
    assertNotNull(recorded, "Cases.java 的文件头里应该记着来源 sha（生成器写的）");
    assertEquals(sha16(Path.of("../spatial-core/test/cases/rules.json")), recorded,
        "Cases.java 落后于用例表了 —— 重跑 `node tools/server/gen-java-data.mjs`，"
            + "并确认 Java 侧跟上了新用例（服务端与用例表逐条同结论这句话才算数）");
  }

  @Test
  @DisplayName("Params.java 不落后于参数表（来源 sha 与真源一致）")
  void paramsAreFresh() throws IOException {
    final String recorded = recordedSha("Params.java", "params.default.json");
    assertNotNull(recorded, "Params.java 的文件头里应该记着来源 sha（生成器写的）");
    assertEquals(sha16(Path.of("../config/params.default.json")), recorded,
        "Params.java 落后于参数表了 —— 重跑 `node tools/server/gen-java-data.mjs`");
  }
}