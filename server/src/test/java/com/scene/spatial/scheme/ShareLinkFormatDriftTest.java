package com.scene.spatial.scheme;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ShareLinkFormatDriftTest —— 分享链接的**形状**不许在两份代码里悄悄漂
 *
 * ## 为什么要有这条
 *
 * 地址形状的**唯一出处**在前端 `app/src/router.js` 的 `shareHref()`（拼地址的其实是浏览器）。
 * 但服务端也留了一份副本 `Share.linkPath()`（它要把路径放进接口响应，也让留痕里能写出链接）。
 * 两份写法一定会漂：改了前端忘了后端 —— **两边都不报错**，只是客户收到一条打不开的链接
 * （`docs/51` 的 D48 家族：同一样东西两个出处）。
 *
 * ## 这条判据做什么
 *
 *   ① 从 `router.js` 里把段名抠出来（`'/段/' + t`）；
 *   ② 断言 `share.js` 把链接拼成 **`origin + shareHref(口令)`**：链接是真实路径，
 *      hash 前缀已经拿掉（U1 起用 vue-router 的 history 模式）。服务端的 `linkPath` 也是真实路径，
 *      任何一侧悄悄拼回 `#`，客户拿到的链接就打不开；
 *   ③ 把两端拼出来的完整相对路径**逐字符比一次**（用固定口令 `aaaaaaaa`）。
 *
 * 任一侧改了而另一侧没改 → 这里红。**找不到仓库根就直接失败**，不 skip：
 * 这个文件在仓库里永远存在（不像 MySQL），跳过就等于养一只瞎眼的检查器（`docs/46` B16 的老账）。
 */
class ShareLinkFormatDriftTest {

  /** 固定口令（8 位、全在去歧义字符集里）—— 只用来比形状，不参与任何真实流程 */
  private static final String TOKEN = "aaaaaaaa";

  /** 从工作目录往上找带 `app/src/router.js` 的那一层 */
  private static Path repoRoot() {
    Path p = Path.of(System.getProperty("user.dir")).toAbsolutePath();
    for (int i = 0; i < 6 && p != null; i++, p = p.getParent()) {
      if (Files.isRegularFile(p.resolve("app/src/router.js"))) {
        return p;
      }
    }
    throw new IllegalStateException("找不到仓库根（含 app/src/router.js）—— 起点："
        + System.getProperty("user.dir"));
  }

  @Test
  @DisplayName("linkPath 的副本 vs router.js / share.js 的真身：段名与拼接形状都要一致")
  void linkShapeDoesNotDrift() throws IOException {
    final Path root = repoRoot();
    final String router = Files.readString(root.resolve("app/src/router.js"), StandardCharsets.UTF_8);
    final String share = Files.readString(root.resolve("app/src/share.js"), StandardCharsets.UTF_8);

    // ① 前端段名（唯一出处）
    final int at = router.indexOf("export function shareHref");
    assertTrue(at > 0, "router.js 里找不到 `export function shareHref` —— 是不是改名字了？");
    final String body = router.substring(at, Math.min(router.length(), at + 400));
    final Matcher m = Pattern.compile("'(/[A-Za-z0-9_-]+/)'\\s*\\+\\s*t").matcher(body);
    assertTrue(m.find(), "shareHref 里找不到 `'/段/' + t` 这种拼法，实际：\n" + body);
    final String seg = m.group(1);

    // ② 完整链接是**真实路径**：`origin + shareHref(口令)`（U1 起用 vue-router 的 history 模式）
    assertTrue(Pattern.compile("\\+\\s*shareHref\\(").matcher(share).find(),
        "share.js 的 absoluteLink 不再是 `origin + shareHref(token)` 这种拼法");
    assertFalse(Pattern.compile("'\\s*#/?\\s*'\\s*\\+\\s*shareHref\\(").matcher(share).find(),
        "share.js 又把链接拼回 hash 上了：那会让前端地址与服务端的 linkPath 分成两种形状。"
            + "要换形状，router.js 的 shareHref、share.js 的 absoluteLink 与 Share.linkPath 必须一起改");

    // ③ 两端拼出来的完整相对路径逐字符相等
    assertEquals(seg + TOKEN, Share.linkPath(TOKEN),
        "Share.linkPath 与前端漂了（前端段名 = " + seg + "）");
  }
}
