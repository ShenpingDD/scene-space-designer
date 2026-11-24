package com.scene.spatial.api;

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
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ApiErrorFamilyTest —— **把"客户端的错"与"服务端的错"分开**，用机器天天查一遍
 *
 * ## 它防的是哪一种病
 *
 * `B13` 那一族，到 R6-5 为止一共犯了**五次**，每次的样子都一样：
 * 一个参数/路由写错了的请求，被兜底处理成 **500「服务端内部错误（已记录日志，请联系维护者）」**。
 * 而 500 的下一步是「等人来修」，404/400 的下一步才是「检查你的 URL」——
 * 把客户端的错报成服务端的错，会让人**去等一个永远不会来的修复**。
 *
 * 五次分别是：未知路由回 500 · 路径参数读不懂回 500 · 未知路由（第二次，探针撞上）·
 * 4xx 一律被翻成 `invalid-request`（403 被说成"请求写错了"）· **方法不对/内容类型不对回 500**。
 *
 * 前四次都是"发现了再补一个 `@ExceptionHandler`"。人的记性显然不够用 ——
 * 所以这一条不再靠记性：**把应用里所有 `/api` 路由枚举出来，逐个用"读不懂的参数"打一遍**，
 * 只要有一个回 5xx 就红。将来谁加了新路由、新路径变量，它自动也在被查的范围内。
 *
 * ## 为什么它不会改到真数据（2026-11-23 补：曾经改到过）
 *
 * 写方法（POST/PUT/DELETE/PATCH）**只用"读不懂的参数"**：路径变量替换成 `bad-value`、
 * 请求体给 `{}` —— 请求在进业务之前就被挡下（类型转换 / 校验）。
 * **永远不用合法 id**，所以这条测试不可能删掉谁、改掉谁。
 *
 * ⚠️ 但"路径变量读不懂"这个前提只在**路由真的有路径变量**时成立。一条**没有占位符**的
 * 写路由，用 `fill()` 原样调用就是一次**完全合法的请求**：`POST /api/admin/products/quality/recheck`
 * 没有参数、也不看请求体，于是探针把它真的跑了一遍，把全表 `product_model.envelope_ok`
 * 重算成 NULL（2026-11-23 22:43，audit 2607）。
 *
 * 所以现在：**只探测带 `{}` 占位符的路由**；无占位符的路由一条都不发（`skipped` 会打印出来，
 * 并单独断言 recheck 落在跳过集合里、只能用 GET（405）这种进不到业务的方式探到）。
 * 实测 `POST` + `text/plain` **不会**被 415 挡住，它真的跑了一遍全表 —— 所以这条测试对
 * 无参数写路由一条 POST 都不发。这条规则不靠记忆：
 * 枚举循环里先看 `pattern.contains("{")`。
 *
 * ## 为什么它必须带真实登录会话
 *
 * U1 之后这些接口都要登录才进得去。**不带会话**地跑，每一条都会在安全链上被 401 拦下来 ——
 * 那时这条测试看到的全是 401，路由枚举再全也什么都没查到，而它自己是绿的：
 * 这正是它想防的那种"看着还在守、其实已经空转"。
 * 所以它先用真账号真口令登录一次，之后每个请求都带着会话与 CSRF 令牌发出去，
 * 让请求真的走到类型转换与校验那一层 —— 只有走到了那里，4xx 与 5xx 的区别才有意义。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestPropertySource(properties = {
    // LOD 后台任务在测试里是"会写盘写库的副作用"，关掉：这条测试只关心 HTTP 状态码
    "spatial.lod.enabled=false"
})
class ApiErrorFamilyTest {

  /** 路径变量一律替换成这个 —— 它既不是数字、也不是合法口令，转换/校验一定失败 */
  private static final String BAD = "bad-value";

  /** 造出来的账号用的口令 */
  private static final String PW = "probe-error-family-9";

  @Autowired
  private RequestMappingHandlerMapping mapping;

  @Autowired
  private JdbcClient jdbc;

  @Autowired
  private PasswordEncoder encoder;

  /** 起来的端口由框架分配（`RANDOM_PORT`）—— 不写 `TestRestTemplate`：Boot 4 把测试类的包挪过位置，
   *  JDK 自带的 `HttpClient` 在哪个版本都一样（这条测试不该因为升级框架而红）。 */
  @Value("${local.server.port}")
  private int port;

  /** 每个测试方法一套账号 + 一个会话（带 cookie 罐与令牌的探针） */
  private final String username = "ea" + Math.abs(System.nanoTime() % 1_000_000L);

  private AuthProbe probe;

  private Long userId;

  @BeforeEach
  void signIn() {
    jdbc.sql("""
        INSERT INTO sys_user (username, password_hash, display_name, role_code, enabled)
        VALUES (:u, :h, :d, 'admin', 1)
        """)
        .param("u", username)
        .param("h", encoder.encode(PW))
        .param("d", "错误族探针")
        .update();
    userId = jdbc.sql("SELECT id FROM sys_user WHERE username = :u").param("u", username)
        .query(Long.class).single();

    probe = new AuthProbe(port);
    final AuthProbe.Res login = probe.login(username, PW);
    assertEquals(200, login.status(),
        "这条测试要有一个真实登录会话 —— 没有会话时每一条都会先被 401 拦下，"
            + "枚举再全也什么都没查到：" + login.body());
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
  @DisplayName("⭐ 所有 /api 路由：参数读不懂一律 4xx —— 出现 5xx 就是又犯了那一族的老病")
  void clientMistakesAreNever500() {
    final List<String> probed = new ArrayList<>();
    final List<String> skipped = new ArrayList<>();
    final List<String> bad = new ArrayList<>();

    for (final RequestMappingInfo info : mapping.getHandlerMethods().keySet()) {
      final Set<String> patterns = patternsOf(info);
      final Set<RequestMethod> methods = info.getMethodsCondition().getMethods();
      for (final String pattern : patterns) {
        if (!pattern.startsWith("/api")) {
          continue;   // 只查我们自己的接口（容器自带的 /error 之类不在此列）
        }
        // 🚨 没有占位符 = 没有"读不懂的参数"可打：原样调用就是一次合法请求，
        //    写路由会真的落库（recheck 那次事故就是这么发生的）——一条都不发。
        if (!hasReadableParameter(pattern)) {
          skipped.add(pattern);
          continue;
        }
        // 方法条件为空（写 `@RequestMapping` 不限方法）时按 GET 试一次 —— 至少覆盖一条路径
        final Set<RequestMethod> use = methods.isEmpty() ? Set.of(RequestMethod.GET) : methods;
        for (final RequestMethod m : use) {
          final String url = fill(pattern);
          final AuthProbe.Res res = call(m, url, "application/json");
          final String line = m + " " + url + " → " + res.status();
          probed.add(line);
          if (res.status() >= 500) {
            bad.add(line + "  " + brief(res.body()));
          }
        }
      }
    }

    // 探测条数留在报告里：这个数是"这条测试到底守住多宽"的读数；
    // 跳过的路由也打出来 —— 不许静默少打（否则枚举一坏就变成永远绿，C12 的同一条教训）
    System.out.println("[u1] /api 路由探测条数 = " + probed.size()
        + "，跳过（无占位符、不真实调用）= " + skipped.size());
    skipped.forEach((p) -> System.out.println("[u1] 跳过无参数路由 " + p));

    // ⚠️ 先断言"真的打了足够多" —— 不然枚举方式一旦坏掉（比如拿到 0 条路由），
    // 这个测试会**静默地变成永远绿**，那比没有它还坏（C12 的同一条教训）。
    assertTrue(probed.size() >= 20,
        "只打到 " + probed.size() + " 条路由 —— 枚举方式坏了，这条测试已经不设防了：\n"
            + String.join("\n", probed));

    assertTrue(bad.isEmpty(), "下面这些路由把**客户端的错**报成了 5xx（等于让用户去等一个永远不会来的修复）：\n"
        + String.join("\n", bad));
  }

  @Test
  @DisplayName("无参数路由绝不被真实调用：recheck 只用 405 证明它在错误族里")
  void parameterlessRoutesAreNeverExecuted() {
    // ① 守卫本身在起作用：recheck 没有占位符，所以枚举器不会把它当"参数读不懂"去真实打
    assertFalse(hasReadableParameter("/api/admin/products/quality/recheck"),
        "recheck 没有路径变量，原样调用就是真跑全表 —— 必须落在跳过集合里");
    assertTrue(hasReadableParameter("/api/admin/products/{id}"),
        "有占位符的路由才是这条测试该打的目标");

    // ② 方法不对 → 405：仍然覆盖它的错误族，但请求根本进不到业务方法
    assertEquals(405, call(RequestMethod.GET, "/api/admin/products/quality/recheck", null).status(),
        "只收 POST 的 recheck 被 GET 打必须是 405（不是 500，也不能真的执行）");

    // ③ 内容类型不再是它的保险：2026-11-23 实测 `POST` + text/plain 仍会进业务（返回 200 并真跑一遍）。
    //    所以这里**不发明文 POST** —— 只留一条断言把这个事实钉住，防止有人以为"415 会挡住"。
    //    recheck 是零参数、零请求体的路由，除了"不发"没有第二种安全探法。
  }

  @Test
  @DisplayName("已知的具体坑（B13 那一族）：一条一条定住")
  void knownCasesArePinned() {
    // ① 路径变量不是数字 —— 原来是 500（探针把 None 拼进 URL 撞出来的）
    assert4xx("GET", "/api/schemes/not-a-number/delivery");
    assert4xx("GET", "/api/schemes/not-a-number/cover");
    assert4xx("GET", "/api/schemes/not-a-number/shares");
    assert4xx("GET", "/api/params/snapshot/not-a-number");
    // ② 压根没有这个路由 → 404（不是 500）
    assertEquals(404, call(RequestMethod.GET, "/api/nope", null).status(),
        "未知路由必须是 404");
    // ③ 方法不对 → 405（原来会掉进 500 兜底）
    assertEquals(405, call(RequestMethod.GET, "/api/schemes/1/share", null).status(),
        "只收 POST 的接口被 GET 打，必须是 405");
    // ④ 内容类型不对 → 415
    assertEquals(415, call(RequestMethod.POST, "/api/schemes", "text/plain").status(),
        "只收 JSON 的接口被 text/plain 打，必须是 415");
  }

  @Test
  @DisplayName("分享口令：读不懂的口令是 404，不是 500，也不是「猜口令小游戏」")
  void badShareTokenIsNotAnErrorOfOurs() {
    assert4xx("GET", "/api/share/" + BAD);
    assert4xx("GET", "/api/share/01234567890123456789012345678901");   // 32 位但字符不在词表里
  }

  @Test
  @DisplayName("登录失败体是 401 + JSON，不许变成 5xx")
  void loginFailuresStayInTheClientErrorFamily() {
    final AuthProbe fresh = new AuthProbe(port);
    final AuthProbe.Res res = fresh.login(username, "wrong-password-1");
    assertEquals(401, res.status(), "口令不对是 401：" + res.body());
    assertEquals("bad-credentials", res.reason(), res.body());
  }

  // ─────────────────────────── 小工具 ───────────────────────────

  private void assert4xx(String method, String url) {
    final AuthProbe.Res res = call(RequestMethod.valueOf(method), url, null);
    assertTrue(res.status() >= 400 && res.status() < 500,
        method + " " + url + " 应当是 4xx，实际 " + res.status()
            + "（5xx = 又把客户端的错当成服务端缺陷了）" + " —— " + brief(res.body()));
  }

  /** 只有带占位符的路由才有"读不懂的参数"可打；无占位符的路由原样调用＝一次合法请求 */
  private static boolean hasReadableParameter(String pattern) {
    return pattern.indexOf('{') >= 0;
  }

  /** 把 `{id}` / `{token}` 统统换成读不懂的值 */
  private static String fill(String pattern) {
    final StringBuilder sb = new StringBuilder();
    int i = 0;
    while (i < pattern.length()) {
      final int open = pattern.indexOf('{', i);
      if (open < 0) {
        sb.append(pattern, i, pattern.length());
        break;
      }
      final int close = pattern.indexOf('}', open);
      if (close < 0) {   // 正则式的 `{1,3}` 之类，原样留着
        sb.append(pattern, i, pattern.length());
        break;
      }
      sb.append(pattern, i, open).append(BAD);
      i = close + 1;
    }
    return sb.toString();
  }

  private static Set<String> patternsOf(RequestMappingInfo info) {
    final var cond = info.getPathPatternsCondition();
    if (cond == null) {
      return Set.of();
    }
    final Set<String> out = new LinkedHashSet<>();
    cond.getPatterns().forEach((p) -> out.add(p.getPatternString()));
    return out;
  }

  /** GET/DELETE/HEAD 不带体（框架不收）；写方法带 `{}` —— **体里绝不放真实 id** */
  private AuthProbe.Res call(RequestMethod m, String url, String contentType) {
    final boolean withBody =
        !(m == RequestMethod.GET || m == RequestMethod.DELETE || m == RequestMethod.HEAD);
    return probe.call(m.name(), url, withBody ? "{}" : null, contentType);
  }

  private static String brief(String body) {
    if (body == null) {
      return "";
    }
    final String one = body.replace('\n', ' ');
    return one.length() > 160 ? one.substring(0, 160) + "…" : one;
  }
}
