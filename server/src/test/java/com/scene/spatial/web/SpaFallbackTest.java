package com.scene.spatial.web;

import com.scene.spatial.auth.AuthProbe;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.TestPropertySource;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * SpaFallbackTest —— 单 jar 形态的页面可达性判据（设计决策记录 §五 第 5 项）
 *
 * ## 它防的是哪一种病
 *
 * 打进 jar 的首页是真的，但**前端路由不是文件**：`/login`、`/design/12`、`/view/<token>`
 * 在磁盘上都没有同名文件。没有兜底时表现是「从入口点进去都正常，一刷新就是 404」——
 * 而这种 404 长得像部署失败，会让人去查 jar、查端口，方向从一开始就错了。
 *
 * ## 为什么用测试资源里的 index.html，而不是 app/dist 那一个
 *
 * 这条判据要说的是「**找不到页面文件时回的是首页**」，所以首页必须带一个只在这条测试里
 * 出现的标记（`spa-fallback-test-index`）：正文里有它，才能证明回的是兜底首页，
 * 而不是碰巧有一个 200 的空响应。默认构建里 `app/dist` 并不会被复制（那是
 * `-Psingle-jar` 的事），所以这里放自己的 `src/test/resources/static/`。
 *
 * ## 反过来也要钉住：兜底**不许**吞掉 404
 *
 * `/api/**`（含 `/api/assets/**` 上传件）、`/assets/**`、`/swagger-ui/**`、`/v3/**`、`/error`
 * 与「带扩展名的路径」找不到时必须是 404，且正文里**不能**有首页标记 —— 把「没有这个接口」
 * 说成 200 + 首页，排错的人会去看首页而不是去看那个地址；前端的 `res.json()` 也会
 * 报一个与真实原因无关的错。
 *
 * ## 为什么要真登录
 *
 * `/api/**` 在连库档里要求已登录，不登录时未知接口是 **401** 而不是 404 ——
 * 那样这条测试判到的只是「安全链挡住了」，兜底有没有吞掉 404 根本没被问到。
 * 所以先造一个真账号、真登录，再打一个不存在的接口。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestPropertySource(properties = {
    // LOD 后台作业在测试里是要写盘写库的副作用，关掉：这条判据只关心 HTTP 状态码与正文
    "spatial.lod.enabled=false"
})
class SpaFallbackTest {

  /** 测试首页里的唯一标记（写成字面量：改坏了这里也要跟着改，不许读常量自证） */
  static final String INDEX_MARKER = "spa-fallback-test-index";

  /** 测试用 js 里的唯一标记 */
  static final String SCRIPT_MARKER = "spa-fallback-test-script";

  /**
   * 七条真实路径（设计决策记录 §五 第 5 项）+ 根路径。
   *
   * `/design/{id}` 与 `/view/{token}` 用具体的值打 —— 兜底之后它们都该拿到同一个首页。
   */
  static final List<String> SPA_ROUTES = List.of(
      "/",
      "/login",
      "/index",
      "/project",
      "/design/new",
      "/design/42",
      "/admin/products",
      "/view/abcdefghijklmnop");

  /** 造出来的账号用的口令 */
  private static final String PW = "probe-spa-fallback-9";

  @Value("${local.server.port}")
  private int port;

  @Autowired
  private JdbcClient jdbc;

  @Autowired
  private PasswordEncoder encoder;

  /** 匿名探针：页面路径不需要登录，用它的请求证明「没登录也能打开页面」 */
  private AuthProbe anon;

  /** 已登录探针：只有它能走到 404 与 401 之分那一层 */
  private AuthProbe signedIn;

  private final String username = "spa" + Math.abs(System.nanoTime() % 1_000_000L);

  private Long userId;

  @BeforeEach
  void signIn() {
    jdbc.sql("""
        INSERT INTO sys_user (username, password_hash, display_name, role_code, enabled)
        VALUES (:u, :h, :d, 'admin', 1)
        """)
        .param("u", username)
        .param("h", encoder.encode(PW))
        .param("d", "单 jar 兜底探针")
        .update();
    userId = jdbc.sql("SELECT id FROM sys_user WHERE username = :u").param("u", username)
        .query(Long.class).single();

    anon = new AuthProbe(port);
    signedIn = new AuthProbe(port);
    final AuthProbe.Res login = signedIn.login(username, PW);
    assertEquals(200, login.status(),
        "这条测试要有一个真实登录会话（否则未知接口是 401 而不是 404）：" + login.body());
  }

  @AfterEach
  void cleanUp() {
    if (userId != null) {
      jdbc.sql("DELETE FROM scheme WHERE owner_id = :id").param("id", userId).update();
      jdbc.sql("DELETE FROM sys_user WHERE id = :id").param("id", userId).update();
      userId = null;
    }
  }

  @Test
  @DisplayName("⭐ 七条真实路径 + 根路径：刷新即 200，正文是首页（兜底真的生效了）")
  void spaRoutesServeTheIndexPage() {
    final List<String> readings = new ArrayList<>();
    final List<String> bad = new ArrayList<>();

    for (final String route : SPA_ROUTES) {
      final AuthProbe.Res res = anon.get(route);
      final String line = route + " → " + res.status();
      readings.add(line);
      if (res.status() != 200) {
        bad.add(line + "（应为 200）");
        continue;
      }
      if (!res.body().contains(INDEX_MARKER)) {
        bad.add(line + "（正文里没有首页标记，回的不是兜底首页）");
      }
      final String contentType = res.header("Content-Type");
      if (contentType == null || !contentType.contains("text/html")) {
        bad.add(line + "（Content-Type 不是 text/html：" + contentType + "）");
      }
    }

    System.out.println("[s2-b] 页面路径实测：" + String.join(" | ", readings));
    assertTrue(bad.isEmpty(), "下面这些页面路径没拿到兜底首页：\n" + String.join("\n", bad));
  }

  @Test
  @DisplayName("真实的静态文件照样原样返回：/index.html 与 /assets/spa-test.js")
  void realStaticFilesAreServedAsFiles() {
    final AuthProbe.Res index = anon.get("/index.html");
    assertEquals(200, index.status(), "静态首页本身必须能取到：/index.html");
    assertTrue(index.body().contains(INDEX_MARKER), "/index.html 的正文必须是那份首页");

    final AuthProbe.Res script = anon.get("/assets/spa-test.js");
    assertEquals(200, script.status(), "构建产物目录里的文件必须原样返回：/assets/spa-test.js");
    assertTrue(script.body().contains(SCRIPT_MARKER),
        "/assets/spa-test.js 的正文必须是那个 js（不是首页）");
    final String contentType = script.header("Content-Type");
    assertTrue(contentType != null && contentType.contains("javascript"),
        "/assets/spa-test.js 的 Content-Type 应含 javascript，实际：" + contentType);
  }

  @Test
  @DisplayName("⭐ 未知接口仍是 404：兜底不许把「没有这个地址」说成 200 + 首页")
  void unknownApiPathStays404() {
    final AuthProbe.Res res = signedIn.get("/api/does-not-exist");
    assertEquals(404, res.status(),
        "/api/does-not-exist 必须是 404（兜底吞掉它的话，前端的 res.json() 会报一个无关的错）："
            + res.body());
    assertFalse(res.body().contains(INDEX_MARKER), "404 的正文里不许出现首页标记：" + res.body());
  }

  @Test
  @DisplayName("未知静态件、接口说明页、带扩展名的路径：一律 404，不被兜底吞掉")
  void nonPagePathsStay404() {
    // /assets/** 是构建产物；/api/assets/** 是上传件（属于接口）—— 两者都不许回首页
    assertNotIndexed("/assets/nope.js");
    assertNotIndexed("/api/assets/nope.png");
    // 接口说明页与它依赖的 webjars 路径
    assertNotIndexed("/swagger-ui/nope");
    assertNotIndexed("/v3/nope");
    // 带扩展名的未知路径 = 在找一个具体文件，不是页面路由
    assertNotIndexed("/missing-page.html");
    assertNotIndexed("/design/42/thumb.webp");
  }

  /** 打一个「不是页面」的地址：必须是 404，且正文里没有首页标记 */
  private void assertNotIndexed(String path) {
    final AuthProbe.Res res = signedIn.get(path);
    assertEquals(404, res.status(), path + " 应当是 404（兜底只该接页面路由）：" + res.body());
    assertFalse(res.body().contains(INDEX_MARKER),
        path + " 的正文里不许出现首页标记：" + res.body());
  }
}
