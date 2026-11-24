package com.scene.spatial.auth;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.TestPropertySource;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * AuthSessionTest —— U1 后端判据（B1–B15）
 *
 * ## 为什么必须是真登录、真 cookie、真库
 *
 * 这一批要判的是「谁登录了」「库里那一行是谁的」「口令散列长什么样」—— 三件事的真相都在服务端。
 * 换成替身身份（`@WithMockUser` 那一族）会把登录、停用、会话、CSRF 四条一起绕过去，
 * 而它们恰好是本批的全部内容。所以这里：真实 `POST /api/auth/login`、真实的会话 cookie、
 * 真实的 `sys_user` 行，判据末尾**回库核对**。
 *
 * ## 账号从哪里来
 *
 * 测试自己造账号（登录名带唯一前缀）与方案，收尾按外键顺序清掉。造账号这一步用真实的散列组件
 * 把散列写进行里 —— 那一行本身是真的，登录也真的走 BCrypt 校验；只有"第一条账号行"这件事
 * 需要一个入口（这也正是 `tools/server/set-password.sh` 存在的理由）。
 *
 * ## 与 设计决策记录的两处口径
 *
 * 第 1 处，登录响应**只有身份**（id / 登录名 / 显示名 / 角色码），能力表从 `/api/admin/me` 读
 * （设计决策记录 §三第 1 项）。第 2 处，停用账号登录回 **403 `account-disabled`**（设计决策记录 §三第 8 项），
 * 理由写在 `ApiProblem.accountDisabled` 的注释里：停用是「你的账号被处理了」，
 * 与「口令敲错了」的下一步动作不同。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestPropertySource(properties = {
    // LOD 后台作业在测试里是要写盘写库的副作用，关掉：这些判据只关心接口行为
    "spatial.lod.enabled=false"
})
class AuthSessionTest {

  /** 造出来的账号统一用这个口令（登录路径真的会拿它做一次 BCrypt 校验） */
  private static final String PW = "probe-password-9";

  /** 换口令那一条要用的第二个口令 */
  private static final String PW2 = "probe-password-2";

  @Value("${local.server.port}")
  private int port;

  @Autowired
  private JdbcClient jdbc;

  @Autowired
  private PasswordEncoder encoder;

  /** 本测试造出来的账号 id（收尾要按它清库） */
  private final List<Long> madeUsers = new ArrayList<>();

  /** 本测试造出来的方案 id（其中 CSRF 那一条不走 `createScheme`，所以两张清单都要有） */
  private final List<Long> madeSchemes = new ArrayList<>();

  /** 每次跑都用新的前缀：同一次 CI 里并发/重复跑也不会撞名 */
  private final String stamp = String.valueOf(Math.abs(System.nanoTime() % 1_000_000L));

  /**
   * 收尾：先删方案、再删账号。
   *
   * 顺序不能反：`scheme.owner_id`（`fk_scheme_owner`）与 `scheme_share.created_by`（`fk_share_user`）
   * 两处外键都没有级联，而 `scheme_revision` / `scheme_share` / `scheme_delivery` 挂着方案级联 ——
   * 先删方案，那些挂着的行跟着走，账号才删得掉。
   */
  @AfterEach
  void cleanup() {
    for (final long id : madeSchemes) {
      jdbc.sql("DELETE FROM scheme WHERE id = :id").param("id", id).update();
    }
    madeSchemes.clear();
    for (final long id : madeUsers) {
      jdbc.sql("DELETE FROM scheme WHERE owner_id = :id").param("id", id).update();
      jdbc.sql("DELETE FROM sys_user WHERE id = :id").param("id", id).update();
    }
    madeUsers.clear();
  }

  // ─────────────────────────── B1–B6 登录与会话 ───────────────────────────

  @Test
  @DisplayName("B1 登录成功：身份进响应，会话能读「我是谁」与能力表")
  void b1_login_grants_a_session() {
    final String u = username("a");
    final long id = makeUser(u, PW, "admin", true);

    final AuthProbe p = probe();
    final AuthProbe.Res login = p.login(u, PW);
    assertEquals(200, login.status(), login.body());
    assertEquals(Boolean.TRUE, login.json().get("ok"));

    final Map<String, Object> user = map(login.json().get("user"));
    assertEquals(id, longOf(user.get("id")), "响应里的身份就是库里那一行");
    assertEquals(u, user.get("username"));
    assertEquals("admin", user.get("roleCode"));
    assertNotNull(user.get("displayName"));
    assertFalse(login.json().containsKey("caps"),
        "登录响应只给身份：能力表只从 /api/admin/me 读（同一件事不留两处出处）");

    final AuthProbe.Res me = p.get("/api/admin/me");
    assertEquals(200, me.status(), me.body());
    assertEquals(id, longOf(me.json().get("userId")), "同一个会话读到的还是这个人");
    assertEquals(Boolean.TRUE, map(me.json().get("caps")).get("manageUsers"),
        "能力表要能回答「谁能管用户」：" + me.body());
    assertTrue(p.cookieNames().contains("SPATIAL_SESSION"),
        "登录要留下会话 cookie，实际：" + p.cookieNames());
  }

  @Test
  @DisplayName("B2 登录失败：账号不存在与口令不对逐字相同，而且拿不到会话")
  void b2_unknown_user_and_wrong_password_are_indistinguishable() {
    final String u = username("b");
    makeUser(u, PW, "designer", true);

    final AuthProbe wrong = probe();
    final AuthProbe.Res bad = wrong.login(u, "not-the-password-1");
    assertEquals(401, bad.status(), bad.body());
    assertEquals("bad-credentials", bad.reason(), bad.body());
    assertEquals(Boolean.FALSE, bad.json().get("ok"));
    assertEquals(401, wrong.get("/api/schemes").status(), "登录失败不给会话");

    final AuthProbe ghost = probe();
    final AuthProbe.Res unknown = ghost.login(username("zz"), "not-the-password-1");
    assertEquals(bad.status(), unknown.status());
    assertEquals(bad.body(), unknown.body(),
        "「账号不存在」与「口令不对」必须逐字相同 —— 否则登录框就成了查询登录名是否存在的工具");
    assertEquals(401, ghost.get("/api/schemes").status(), "账号不存在也不给会话");
  }

  @Test
  @DisplayName("B3 停用账号：正确口令也登不进来，启用之后同一个口令能过")
  void b3_disabled_account_cannot_log_in() {
    final String u = username("c");
    final long id = makeUser(u, PW, "designer", false);

    final AuthProbe p = probe();
    final AuthProbe.Res off = p.login(u, PW);
    assertEquals(403, off.status(), off.body());
    assertEquals("account-disabled", off.reason(), off.body());
    assertTrue(String.valueOf(off.json().get("message")).contains("停用"),
        "拒的原因要说清「账号已停用」（下一步是找管理员）：" + off.body());

    jdbc.sql("UPDATE sys_user SET enabled = 1 WHERE id = :id").param("id", id).update();
    final AuthProbe.Res on = p.login(u, PW);
    assertEquals(200, on.status(),
        "同一个口令在账号启用之后能过 —— 这一半证明前一半被拒的原因确实是停用：" + on.body());
  }

  @Test
  @DisplayName("B4 退出登录：服务端的会话真的没了（不只是前端清了状态）")
  void b4_logout_ends_the_session_on_the_server() {
    final String u = username("d");
    makeUser(u, PW, "designer", true);

    final AuthProbe p = probe();
    assertEquals(200, p.login(u, PW).status());
    assertEquals(200, p.get("/api/schemes").status(), "登录之后这个 cookie 本来是有效的");

    assertEquals(200, p.logout().status());
    assertEquals(401, p.get("/api/schemes").status(), "退出之后同一个 cookie 必须失效");

    assertEquals(200, p.login(u, PW).status());
    assertEquals(200, p.get("/api/schemes").status(), "重新登录之后又能用");
  }

  @Test
  @DisplayName("B5 未登录一律 401 + JSON；同一批接口带上会话就能过，且两种原因码可分辨")
  void b5_unauthenticated_is_401_json_and_authenticated_is_not() {
    final String admin = username("e");
    makeUser(admin, PW, "admin", true);
    final String designer = username("e2");
    makeUser(designer, PW, "designer", true);

    final AuthProbe anon = probe();
    anon.primeCsrf();   // 真实界面在未登录时也会取令牌（不取的话写请求会先在 CSRF 那一层被挡）
    // 这一行把「未登录打受保护接口」的实际响应体留在报告里（判据失败时不必靠猜）
    final AuthProbe.Res sample = anon.get("/api/schemes");
    System.out.println("[u1] 未登录 GET /api/schemes → " + sample.status() + " " + sample.body());
    for (final String path : new String[]{"/api/schemes", "/api/admin/system", "/api/admin/users"}) {
      final AuthProbe.Res r = anon.get(path);
      assertEquals(401, r.status(), path + " 未登录必须 401：" + r.body());
      assertEquals(Boolean.FALSE, r.json().get("ok"), path + " 的失败体要照旧：" + r.body());
      assertEquals("unauthorized", r.reason(), path + " 未登录的原因码：" + r.body());
      assertEquals("application/json", contentTypeOf(r), path + " 回的是 JSON 体");
    }
    assertEquals(401, anon.post("/api/audit", Map.of()).status(), "未登录的写请求也要 401");

    final AuthProbe adminProbe = probe();
    assertEquals(200, adminProbe.login(admin, PW).status());
    for (final String path : new String[]{"/api/schemes", "/api/admin/system", "/api/admin/users"}) {
      assertEquals(200, adminProbe.get(path).status(), path + " 带上 admin 会话要能过");
    }
    assertNotEquals(401, adminProbe.post("/api/audit", Map.of()).status(),
        "带上会话之后不再是「没登录」（业务校验另算）");

    final AuthProbe designerProbe = probe();
    assertEquals(200, designerProbe.login(designer, PW).status());
    final AuthProbe.Res refused = designerProbe.get("/api/admin/users");
    assertEquals(403, refused.status(), "designer 管不了用户：" + refused.body());
    assertEquals("forbidden", refused.reason(), "「角色不够」与「没登录」必须是两种原因码");
  }

  @Test
  @DisplayName("B6 放行清单是逐个写出来的：健康检查 / 目录 / 参数 / 分享匿名可读，受保护接口仍然 401")
  void b6_permit_list_is_narrow() {
    final String u = username("f");
    makeUser(u, PW, "designer", true);
    final AuthProbe owner = probe();
    assertEquals(200, owner.login(u, PW).status());
    final long id = createScheme(owner, "分享给客户看的库房");
    final AuthProbe.Res share = owner.post("/api/schemes/" + id + "/share", Map.of("days", 7));
    assertEquals(200, share.status(), share.body());
    final String token = String.valueOf(share.json().get("token"));

    final AuthProbe anon = probe();
    assertEquals(200, anon.get("/api/health").status(), "健康检查要能匿名打（start.sh 靠它）");
    assertEquals(200, anon.get("/api/health/kernel").status(), "内核自检也要能匿名打");
    assertEquals(200, anon.get("/api/catalog").status(), "型号目录要能匿名打（登录页外壳就要用）");
    // 设计决策记录：详情与目录同一档公共读；不存在的 id 是 404 业务结论，绝不是 401
    assertEquals(404, anon.get("/api/catalog/__no_such_product__/detail").status(),
        "详情接口也要匿名可读（404 是产品不存在，不是没登录）");
    final AuthProbe.Res cat = anon.get("/api/catalog");
    @SuppressWarnings("unchecked")
    final List<Map<String, Object>> products = (List<Map<String, Object>>) cat.json().get("products");
    final Map<String, Object> withDetail = products.stream()
        .filter(p -> Boolean.TRUE.equals(p.get("hasDetail"))).findFirst().orElse(null);
    assertNotNull(withDetail, "目录里至少要有一款 hasDetail=true 的产品");
    final String detailPath = "/api/catalog/" + withDetail.get("id") + "/detail";
    final AuthProbe.Res detail = anon.get(detailPath);
    assertEquals(200, detail.status(), "老产品详情要 200 投影，不能 404：" + detail.body());
    assertNotNull(detail.header("ETag"), "详情要带 ETag");
    assertEquals(304, anon.getWithEtag(detailPath, detail.header("ETag")).status(),
        "If-None-Match 命中要回 304");
    assertEquals(200, anon.get("/api/params").status(), "参数表要能匿名打");

    final AuthProbe.Res shared = anon.get("/api/share/" + token);
    assertEquals(200, shared.status(), "免登录分享要能匿名打：" + shared.body());
    assertEquals(Boolean.TRUE, shared.json().get("ok"), shared.body());
    assertNotNull(shared.json().get("name"), "分享页要读得到方案名：" + shared.body());

    for (final String path : new String[]{"/", "/index.html", "/assets/whatever.png", "/login"}) {
      assertNotEquals(401, anon.get(path).status(),
          path + " 不在接口清单里：这一档的后台只服务 /api/**，这个地址不该答成「没登录」");
    }
    assertEquals(401, anon.get("/api/schemes").status(),
        "同一时刻受保护接口仍然 401 —— 放行清单是逐个写出来的，没有整体放开 /api/**");
  }

  // ─────────────────────────── B7–B8 归属隔离 ───────────────────────────

  @Test
  @DisplayName("B7 越权读：同一个方案 id，本人在 200、别人在 404，且列表里看不到")
  void b7_another_accounts_scheme_is_not_found() {
    final String ua = username("g");
    final String ub = username("h");
    makeUser(ua, PW, "designer", true);
    makeUser(ub, PW, "designer", true);

    final AuthProbe a = probe();
    assertEquals(200, a.login(ua, PW).status());
    final AuthProbe b = probe();
    assertEquals(200, b.login(ub, PW).status());

    final long s1 = createScheme(a, "A 的库房");
    final long s2 = createScheme(b, "B 的库房");

    final AuthProbe.Res foreign = b.get("/api/schemes/" + s1);
    assertEquals(404, foreign.status(), "别人的方案按 id 直取也是 404：" + foreign.body());
    assertEquals("not-found", foreign.reason(), foreign.body());

    final Map<Long, Map<String, Object>> listB = byId(b.get("/api/schemes").json().get("schemes"));
    assertFalse(listB.containsKey(s1), "B 的列表里不许出现 A 的方案");
    assertTrue(listB.containsKey(s2), "B 的列表里要有自己的方案");

    final AuthProbe.Res own = a.get("/api/schemes/" + s1);
    assertEquals(200, own.status(), own.body());
    assertEquals("A 的库房", own.json().get("name"));
    assertEquals(8, ((Number) map(own.json().get("state")).get("w")).intValue(),
        "本人读到的内容与建的时候一致");
  }

  @Test
  @DisplayName("B8 越权写：每一个写口都挡下，回库核对一处没变；本人做同一批调用则真的改到")
  void b8_another_accounts_scheme_cannot_be_written() {
    final String ua = username("i");
    final String ub = username("j");
    makeUser(ua, PW, "designer", true);
    makeUser(ub, PW, "designer", true);

    final AuthProbe a = probe();
    assertEquals(200, a.login(ua, PW).status());
    final AuthProbe b = probe();
    assertEquals(200, b.login(ub, PW).status());

    final long s1 = createScheme(a, "A 的库房");
    assertEquals(200, a.post("/api/schemes/" + s1 + "/share", Map.of("days", 7)).status(),
        "先发一条口令，后面要核对方案有没有被越权改动");

    final Map<String, Object> before = schemeRow(s1);
    final long sharesBefore = count("SELECT COUNT(*) FROM scheme_share WHERE scheme_id = :id", s1);

    final Map<String, AuthProbe.Res> blocked = new LinkedHashMap<>();
    blocked.put("PUT /{id}", b.put("/api/schemes/" + s1, saveBody(1, "被改掉了")));
    blocked.put("DELETE /{id}", b.delete("/api/schemes/" + s1));
    blocked.put("GET /{id}/revisions", b.get("/api/schemes/" + s1 + "/revisions"));
    blocked.put("GET /{id}/shares", b.get("/api/schemes/" + s1 + "/shares"));
    blocked.put("GET /{id}/deliveries", b.get("/api/schemes/" + s1 + "/deliveries"));
    blocked.put("GET /{id}/cover", b.get("/api/schemes/" + s1 + "/cover"));
    // 回滚那一口的入参自检（两个版本号必须自洽）排在归属判定之前，而它只看请求里的两个数字、
    // 不读库 —— 所以这里给一组自洽的入参，才走得到归属那一层
    blocked.put("POST /{id}/rollback", b.post("/api/schemes/" + s1 + "/rollback",
        Map.of("targetRev", 1, "expectRev", 2)));
    blocked.put("POST /{id}/cover", b.post("/api/schemes/" + s1 + "/cover",
        Map.of("dataUrl", "data:image/png;base64,AAAA")));
    blocked.put("POST /{id}/share", b.post("/api/schemes/" + s1 + "/share", Map.of("days", 7)));
    blocked.put("POST /{id}/delivery", b.post("/api/schemes/" + s1 + "/delivery",
        Map.of("expectRev", 1)));
    blocked.put("POST /{id}/restore", b.post("/api/schemes/" + s1 + "/restore", Map.of()));
    blocked.put("POST /{id}/duplicate", b.post("/api/schemes/" + s1 + "/duplicate", Map.of()));
    blocked.put("POST /{id}/recheck", b.post("/api/schemes/" + s1 + "/recheck", Map.of()));
    blocked.put("POST /{id}/delivery-state", b.post("/api/schemes/" + s1 + "/delivery-state",
        Map.of("status", "delivered", "note", "越权试试")));

    for (final Map.Entry<String, AuthProbe.Res> e : blocked.entrySet()) {
      final AuthProbe.Res r = e.getValue();
      assertTrue(r.status() >= 400 && r.status() < 500,
          e.getKey() + " 越权必须 4xx，实际 " + r.status() + "：" + r.body());
      if (!e.getKey().startsWith("POST /{id}/cover")) {
        // 封面那一路的入参校验排在归属判定之前（先解码图片），所以越权时先撞上 bad-cover。
        // 归属仍然成立：库里一处没变 —— 见下面这一段回库核对。
        assertEquals(404, r.status(), e.getKey() + " 越权应当是 404（别人的方案在这里就是不存在）："
            + r.body());
      }
    }

    final Map<String, Object> after = schemeRow(s1);
    assertEquals(before.get("rev"), after.get("rev"), "越权写不许动 rev");
    assertEquals(before.get("name"), after.get("name"), "越权写不许改名");
    assertEquals(before.get("deleted"), after.get("deleted"), "越权写不许把方案标成删除状态");
    assertEquals(before.get("cover_file"), after.get("cover_file"), "越权写不许换封面");
    assertEquals(sharesBefore, count("SELECT COUNT(*) FROM scheme_share WHERE scheme_id = :id", s1),
        "越权不许发出分享口令");

    // 成对：本人做同一批调用是有效的 —— 证明 404 的原因确实是归属（这套调用本身是好的）
    final AuthProbe.Res ownSave = a.put("/api/schemes/" + s1, saveBody(1, "A 自己改的"));
    assertEquals(200, ownSave.status(), "本人保存要能过：" + ownSave.body());
    assertEquals("A 自己改的", schemeRow(s1).get("name"), "本人保存真的改到了库里");
    assertEquals(200, a.get("/api/schemes/" + s1 + "/revisions").status(), "本人看得见留痕");
    assertEquals(200, a.post("/api/schemes/" + s1 + "/share", Map.of("days", 7)).status(),
        "本人发得出分享口令");
  }

  // ─────────────────────────── B9–B12 口令与用户管理 ───────────────────────────

  @Test
  @DisplayName("B9 口令散列：同一个口令两次不同，都能校验通过，且明文没进库")
  void b9_password_hashes_get_a_fresh_salt() {
    final String admin = username("k");
    makeUser(admin, PW, "admin", true);
    final AuthProbe probe = probe();
    assertEquals(200, probe.login(admin, PW).status());

    final String u1 = username("k1");
    final String u2 = username("k2");
    for (final String u : new String[]{u1, u2}) {
      final AuthProbe.Res made = probe.post("/api/admin/users", userBody(u, "designer", PW));
      assertEquals(200, made.status(), made.body());
      madeUsers.add(userId(u));
    }

    final String h1 = hashOf(u1);
    final String h2 = hashOf(u2);
    assertNotEquals(h1, h2, "同一个口令两次散列必须不同（盐每次都要新取）");
    assertTrue(encoder.matches(PW, h1), "两个散列都要能被校验通过：" + h1);
    assertTrue(encoder.matches(PW, h2), "两个散列都要能被校验通过：" + h2);
    assertFalse(encoder.matches(PW + "x", h1), "错口令必须校验不过");
    for (final String h : new String[]{h1, h2}) {
      assertTrue(h.startsWith("$2a$") || h.startsWith("$2b$") || h.startsWith("$2y$"),
          "要是 BCrypt 散列：" + h);
      assertTrue(h.length() <= 100, "password_hash 是 VARCHAR(100)，实际 " + h.length());
      assertFalse(h.contains(PW), "散列里不许出现明文");
    }
  }

  @Test
  @DisplayName("B10 用户增删改查：建 / 列 / 改 / 重置口令 / 停用 / 删除，每一步都回库核对")
  void b10_user_crud() {
    final String admin = username("l");
    makeUser(admin, PW, "admin", true);
    final AuthProbe probe = probe();
    assertEquals(200, probe.login(admin, PW).status());

    final String target = username("l1");
    final AuthProbe.Res made = probe.post("/api/admin/users", userBody(target, "designer", PW2));
    assertEquals(200, made.status(), made.body());
    final long id = userId(target);
    madeUsers.add(id);
    final Map<String, Object> row = userRow(id);
    assertEquals("designer", row.get("role_code"), "① 建号：库里那一行的角色");
    assertEquals(Boolean.TRUE, row.get("enabled"), "① 给了口令就是启用着的");
    assertTrue(hashOf(target).startsWith("$2"), "① 库里存的是散列，明文没进库");

    final Map<Long, Map<String, Object>> listed = byId(probe.get("/api/admin/users").json().get("users"));
    assertTrue(listed.containsKey(id), "② 列表里出现这个账号");
    assertEquals(Boolean.TRUE, listed.get(id).get("passwordSet"), "② 界面要能回答「口令设过没有」");
    assertEquals(Boolean.TRUE, listed.get(id).get("enabled"));

    final Map<String, Object> patch = new LinkedHashMap<>();
    patch.put("displayName", "改过的显示名");
    patch.put("roleCode", "editor");
    assertEquals(200, probe.patch("/api/admin/users/" + id, patch).status(), "③ 改显示名与角色");
    assertEquals("改过的显示名", userRow(id).get("display_name"));
    assertEquals("editor", userRow(id).get("role_code"), "③ 角色改到库里");

    final AuthProbe asTarget = probe();
    assertEquals(200, asTarget.login(target, PW2).status(), "④ 改口令之前旧口令能用");
    assertEquals(200, probe.post("/api/admin/users/" + id + "/password",
        Map.of("password", PW + "-new")).status(), "④ 重置口令");
    assertEquals(401, probe().login(target, PW2).status(), "④ 旧口令不能再登录");
    assertEquals(200, probe().login(target, PW + "-new").status(), "④ 新口令能登录");

    final AuthProbe disabled = probe();
    assertEquals(200, probe.patch("/api/admin/users/" + id, Map.of("enabled", false)).status(),
        "⑤ 停用");
    assertEquals(Boolean.FALSE, userRow(id).get("enabled"), "⑤ 库里真的停了");
    final AuthProbe.Res refused = disabled.login(target, PW + "-new");
    assertEquals("account-disabled", refused.reason(), "⑤ 停用的账号登不进来：" + refused.body());

    final String removable = username("l2");
    assertEquals(200, probe.post("/api/admin/users", userBody(removable, "viewer", PW2)).status());
    final long removableId = userId(removable);
    madeUsers.add(removableId);
    final AuthProbe.Res removed = probe.delete("/api/admin/users/" + removableId);
    assertEquals(200, removed.status(), removed.body());
    assertEquals(0L, count("SELECT COUNT(*) FROM sys_user WHERE id = :id", removableId),
        "⑥ 没有方案的账号删得掉，而且真的从库里消失");

    // 成对：⑦ 名下有方案的账号删不掉，而且他的方案一个都没少
    final long owner = makeUser(username("l3"), PW, "designer", true);
    final AuthProbe ownerProbe = probe();
    assertEquals(200, ownerProbe.login(username("l3"), PW).status());
    createScheme(ownerProbe, "有方案的账号");
    final AuthProbe.Res inUse = probe.delete("/api/admin/users/" + owner);
    assertEquals(409, inUse.status(), "⑦ 名下有方案的账号不许删：" + inUse.body());
    assertEquals("user-in-use", inUse.reason(), inUse.body());
    assertTrue(String.valueOf(inUse.json().get("message")).contains("方案"),
        "⑦ 要说清被什么占着：" + inUse.body());
    assertNotNull(inUse.json().get("schemes"), "⑦ 带计数，界面才说得清：" + inUse.body());
    assertEquals(1L, count("SELECT COUNT(*) FROM sys_user WHERE id = :id", owner), "⑦ 账号还在");
    assertEquals(1L, count("SELECT COUNT(*) FROM scheme WHERE owner_id = :id", owner),
        "⑦ 方案也没被连带删掉");
  }

  @Test
  @DisplayName("B10-角色 角色码只认四档：写一个认不得的角色码要回 400，不许写进库")
  void b10_role_code_must_be_one_of_the_four() {
    final String admin = username("m1");
    makeUser(admin, PW, "admin", true);
    final AuthProbe probe = probe();
    assertEquals(200, probe.login(admin, PW).status());

    final String target = username("m2");
    final AuthProbe.Res bad = probe.post("/api/admin/users", userBody(target, "draft", PW2));
    assertEquals(400, bad.status(), bad.body());
    assertEquals("bad-role", bad.reason(), bad.body());
    assertEquals(0L, count("SELECT COUNT(*) FROM sys_user WHERE username = :u", target),
        "认不得的角色码不许写进库（写进去就是一个谁都进不来的号）");
  }

  @Test
  @DisplayName("B11 登录名唯一：撞名回 409 conflict，库里只多第一次那一行")
  void b11_duplicate_username_is_a_conflict() {
    final String admin = username("n1");
    makeUser(admin, PW, "admin", true);
    final AuthProbe probe = probe();
    assertEquals(200, probe.login(admin, PW).status());

    final String target = username("n2");
    final long before = count("SELECT COUNT(*) FROM sys_user WHERE username = :u", target);
    assertEquals(200, probe.post("/api/admin/users", userBody(target, "designer", PW2)).status());
    madeUsers.add(userId(target));
    assertEquals(before + 1, count("SELECT COUNT(*) FROM sys_user WHERE username = :u", target));

    final AuthProbe.Res dup = probe.post("/api/admin/users", userBody(target, "designer", PW2));
    assertEquals(409, dup.status(), "撞名要有自己的状态码，不许并进通用的 400：" + dup.body());
    assertEquals("conflict", dup.reason(), dup.body());
    assertEquals(before + 1, count("SELECT COUNT(*) FROM sys_user WHERE username = :u", target),
        "撞名失败之后库里没有多出第二行");
  }

  @Test
  @DisplayName("B12 会话 cookie：HttpOnly、Path=/、不带 Secure，而且收下之后真的能用")
  void b12_session_cookie_attributes() {
    final String u = username("o");
    makeUser(u, PW, "designer", true);

    final AuthProbe p = probe();
    final List<String> setCookies = new ArrayList<>(p.primeCsrf().headers().allValues("set-cookie"));
    final Map<String, Object> body = new LinkedHashMap<>();
    body.put("username", u);
    body.put("password", PW);
    final AuthProbe.Res login = p.post("/api/auth/login", body);
    setCookies.addAll(login.headers().allValues("set-cookie"));
    assertEquals(200, login.status(), login.body());

    final String session = setCookies.stream()
        .filter(c -> c.startsWith("SPATIAL_SESSION="))
        .findFirst()
        .orElseThrow(() -> new AssertionError("登录响应里没有会话 cookie，实际：" + setCookies));
    final String lower = session.toLowerCase(Locale.ROOT);
    assertTrue(lower.contains("httponly"), "会话 cookie 要 HttpOnly：" + session);
    assertTrue(session.contains("Path=/"), "会话 cookie 要 Path=/：" + session);
    assertFalse(lower.contains("secure"),
        "内网明文 HTTP 下不许带 Secure —— 带上之后浏览器不回发，表现是「登录成功但下一个请求仍未登录」："
            + session);

    assertEquals(200, p.get("/api/schemes").status(),
        "收下这个 cookie 之后要能过（这一半把「Secure 导致发不出去」也判掉了）");
  }

  // ─────────────────────────── B13–B15 维护端与命令行 ───────────────────────────

  @Test
  @DisplayName("B13 维护端看全部账号的方案并带归属显示名；designer 被挡在 403")
  void b13_admin_sees_every_accounts_scheme_with_owner_name() {
    final String ua = username("p1");
    final String ub = username("p2");
    final long idA = makeUser(ua, PW, "designer", true);
    makeUser(ub, PW, "designer", true);
    final String admin = username("p3");
    makeUser(admin, PW, "admin", true);

    final AuthProbe a = probe();
    assertEquals(200, a.login(ua, PW).status());
    final AuthProbe b = probe();
    assertEquals(200, b.login(ub, PW).status());
    final long s1 = createScheme(a, "归属探针 " + stamp + " A");
    final long s2 = createScheme(b, "归属探针 " + stamp + " B");

    final AuthProbe adminProbe = probe();
    assertEquals(200, adminProbe.login(admin, PW).status());
    final AuthProbe.Res all = adminProbe.get("/api/admin/schemes");
    assertEquals(200, all.status(), all.body());
    final Map<Long, Map<String, Object>> rows = byId(all.json().get("schemes"));
    assertTrue(rows.containsKey(s1) && rows.containsKey(s2),
        "① 维护端要看得到两个账号的方案（自己的与他人的都在这一份里）：" + all.body());
    assertEquals(idA, longOf(rows.get(s1).get("ownerId")), "② 行里带归属账号 id");
    assertEquals(display(ua), rows.get(s1).get("ownerName"),
        "② 归属人给显示名，不给 #id：" + rows.get(s1));
    assertEquals(Boolean.TRUE, rows.get(s1).get("ownerEnabled"), "② 还要能看出「那个账号还启用着吗」");

    final AuthProbe.Res onlyA = adminProbe.get("/api/admin/schemes?ownerId=" + idA);
    assertEquals(200, onlyA.status(), onlyA.body());
    assertTrue(byId(onlyA.json().get("schemes")).containsKey(s1), "按 ownerId 筛要留得下 A 的方案");
    assertFalse(byId(onlyA.json().get("schemes")).containsKey(s2), "按 ownerId 筛要把 B 的筛掉");

    final AuthProbe.Res byQ = adminProbe.get("/api/admin/schemes?q=" + stamp);
    assertEquals(200, byQ.status(), byQ.body());
    assertTrue(byId(byQ.json().get("schemes")).containsKey(s1), "按名字筛要命中");

    final AuthProbe.Res refused = a.get("/api/admin/schemes");
    assertEquals(403, refused.status(), "③ designer 进不了维护端方案库：" + refused.body());
    assertEquals("forbidden", refused.reason(), refused.body());
  }

  @Test
  @DisplayName("B14 归属闭环：库里 owner_id / updated_by / 审计 actor 三处都是登录账号，交付包也按归属")
  void b14_ownership_is_written_at_every_point() {
    final String designer = username("q1");
    final long designerId = makeUser(designer, PW, "designer", true);
    final String admin = username("q2");
    makeUser(admin, PW, "admin", true);

    final AuthProbe d = probe();
    assertEquals(200, d.login(designer, PW).status());
    final long id = createScheme(d, "归属闭环探针");
    assertEquals(designerId, longOf(schemeRow(id).get("owner_id")),
        "方案归属的是登录账号，这个 ID 来自会话");

    final AuthProbe.Res state = d.post("/api/schemes/" + id + "/delivery-state",
        Map.of("status", "draft", "note", "归属闭环：记一次状态"));
    assertEquals(200, state.status(), state.body());
    assertEquals(designer, schemeRow(id).get("updated_by"), "改动人写的是登录名快照");
    assertEquals(designer, jdbc.sql(
            "SELECT actor FROM audit_log WHERE target_type = 'scheme' AND target_id = :id"
                + " ORDER BY id DESC LIMIT 1")
        .param("id", String.valueOf(id)).query(String.class).optional().orElse(null),
        "审计里那条的 actor 也是登录名");

    final AuthProbe adminProbe = probe();
    assertEquals(200, adminProbe.login(admin, PW).status());
    final AuthProbe.Res foreign = adminProbe.post("/api/schemes/" + id + "/delivery",
        Map.of("expectRev", 1));
    assertEquals(404, foreign.status(),
        "交付包这一族也按归属：admin 打别人的方案同样是 404：" + foreign.body());

    // 最小请求体（只带 expectRev，其余可选项一个都不传）要能过 JSON 绑定：
    // 打一个不存在的方案 id，应当是 404。少写一个可选项就让整个请求体读不进来的话，
    // 接口说明里「这一项不传就是默认」那句话就成了空话
    final AuthProbe.Res minimal = d.post("/api/schemes/999999999/delivery", Map.of("expectRev", 1));
    assertEquals(404, minimal.status(),
        "只带 expectRev 的最小请求体要能过绑定（4xx 的 reason 不该是 bad-json）：" + minimal.body());
    assertNotEquals(200, adminProbe.get("/api/schemes/" + id).status(),
        "维护端身份也不许直接读别人的方案内容（要看就看维护端那一口）");
  }

  @Test
  @DisplayName("B15 一次性设口令的命令：真的写进库、角色与启用状态如预期、没有默认口令这条路")
  void b15_password_tool_sets_a_real_hash_and_never_defaults() throws Exception {
    final String u = username("r");
    final long id = makeUser(u, PW, "designer", false);
    final String before = hashOf(u);

    assertEquals(0, passwordTool(u, "tool-password-1"), "改到 1 行要回退出码 0");
    assertEquals(1L, count("SELECT COUNT(*) FROM sys_user WHERE id = :id AND enabled = 1", id),
        "设过口令的账号要被启用");
    assertEquals("designer", userRow(id).get("role_code"), "角色不许被动");
    assertNotEquals(before, hashOf(u), "口令散列要真的变了");
    assertTrue(encoder.matches("tool-password-1", hashOf(u)), "新口令要能校验通过");

    assertEquals(2, PasswordTool.run("   "), "没有登录名时响亮地拒绝，不许拿任何默认口令顶上去");
    assertEquals(1, passwordTool(username("rnobody"), "tool-password-2"),
        "用户名不存在时回 1（一行都没改到），不许假装成功");

    final String v16 = Files.readString(
        Path.of("src/main/resources/db/migration/V16__accounts_and_login.sql"), StandardCharsets.UTF_8);
    assertFalse(v16.contains("$2a$") || v16.contains("$2b$") || v16.contains("$2y$"),
        "迁移里不许出现口令散列字面量");
    assertFalse(v16.contains("tool-password-1") || v16.contains(PW),
        "迁移里不许出现明文口令");
  }

  /**
   * 把一条口令从标准输入喂给 `PasswordTool.run`，返回退出码。
   *
   * 测试进程里 `System.console()` 是空的，`PasswordTool` 会走"从标准输入读一行"那条路 ——
   * 这条路正是脚本里 `printf ... | java -jar ...` 用的同一条。
   */
  private static int passwordTool(String username, String password) {
    final InputStream saved = System.in;
    System.setIn(new ByteArrayInputStream((password + "\n").getBytes(StandardCharsets.UTF_8)));
    try {
      return PasswordTool.run(username);
    } finally {
      System.setIn(saved);
    }
  }

  // ─────────────────────────── CSRF 与停用生效 ───────────────────────────

  @Test
  @DisplayName("CSRF：不带令牌头的写请求要被挡下，带上才能过（令牌真的在服务端被校验）")
  void csrf_token_is_actually_checked() {
    final String u = username("s");
    makeUser(u, PW, "designer", true);
    final AuthProbe p = probe();
    assertEquals(200, p.login(u, PW).status());
    assertNotNull(p.csrf(), "登录流程本身要取到令牌（真实界面在启动时就是这么做的）");

    final String body = "{\"name\":\"没有令牌\",\"state\":{\"w\":8,\"d\":6,\"h\":2.8,\"walls\":[],\"items\":[]}}";
    final AuthProbe.Res noToken =
        p.callWithoutCsrf("POST", "/api/schemes", body, "application/json");
    assertEquals(403, noToken.status(), "不带令牌的写请求必须被挡下：" + noToken.body());
    assertEquals("bad-csrf", noToken.reason(), noToken.body());

    final AuthProbe.Res withToken = p.call("POST", "/api/schemes", body, "application/json");
    assertEquals(201, withToken.status(), "带上令牌就能过：" + withToken.body());
    assertEquals("没有令牌", withToken.json().get("name"), "带上令牌之后真的建成了：" + withToken.body());
  }

  @Test
  @DisplayName("停用与改口令立刻生效：手上的会话下一个请求就作废")
  void disabling_an_account_kills_its_live_session() {
    final String u = username("t");
    final long id = makeUser(u, PW, "designer", true);

    final AuthProbe p = probe();
    assertEquals(200, p.login(u, PW).status());
    assertEquals(200, p.get("/api/schemes").status(), "停用之前这个会话是有效的");

    jdbc.sql("UPDATE sys_user SET enabled = 0 WHERE id = :id").param("id", id).update();
    final AuthProbe.Res after = p.get("/api/schemes");
    assertEquals(401, after.status(),
        "停用要立刻作废手上的会话 —— 不然这颗按钮按下去要等到会话闲置超时（8 小时）：" + after.body());

    jdbc.sql("UPDATE sys_user SET enabled = 1 WHERE id = :id").param("id", id).update();
    final AuthProbe again = probe();
    assertEquals(200, again.login(u, PW).status());

    jdbc.sql("UPDATE sys_user SET password_hash = :h WHERE id = :id")
        .param("h", encoder.encode(PW2)).param("id", id).update();
    final AuthProbe.Res changed = again.get("/api/schemes");
    assertEquals(401, changed.status(), "口令被改过之后，旧会话也要作废：" + changed.body());
  }

  @Test
  @DisplayName("B10-自保 自己不能停用自己、也不能删掉自己")
  void b10_self_protection() {
    final String admin = username("u1");
    final long adminId = makeUser(admin, PW, "admin", true);
    final AuthProbe probe = probe();
    assertEquals(200, probe.login(admin, PW).status());

    final AuthProbe.Res stopSelf =
        probe.patch("/api/admin/users/" + adminId, Map.of("enabled", false));
    assertEquals(400, stopSelf.status(), "停用自己会把自己关在门外：" + stopSelf.body());
    assertEquals("self-lockout", stopSelf.reason(), stopSelf.body());
    assertEquals(1L, count("SELECT COUNT(*) FROM sys_user WHERE id = :id AND enabled = 1", adminId),
        "被拒之后那一行还是启用着的");

    final AuthProbe.Res deleteSelf = probe.delete("/api/admin/users/" + adminId);
    assertEquals(400, deleteSelf.status(), "删除自己同样要拒：" + deleteSelf.body());
    assertEquals("self-lockout", deleteSelf.reason(), deleteSelf.body());

    // 「不许去掉最后一名管理员」这一条只在库里确实只剩这一个启用着的管理员时才判得出来。
    // 开发库上通常还留着另一个管理员行，那种情况下这一条会跳过 —— 跳过是看得见的，不冒充通过。
    final long otherAdmins = count(
        "SELECT COUNT(*) FROM sys_user WHERE role_code = 'admin' AND enabled = 1 AND id <> :id",
        adminId);
    assumeTrue(otherAdmins == 0,
        "共享开发库里还有 " + otherAdmins + " 个启用着的管理员，这一条留到真实机器上的探针");
    final AuthProbe.Res demote =
        probe.patch("/api/admin/users/" + adminId, Map.of("roleCode", "designer"));
    assertEquals(400, demote.status(), "最后一名管理员不许被降级：" + demote.body());
    assertEquals("last-admin", demote.reason(), demote.body());
    assertEquals("admin", userRow(adminId).get("role_code"), "被拒之后角色没变");
  }

  // ─────────────────────────── 小工具 ───────────────────────────

  private AuthProbe probe() {
    return new AuthProbe(port);
  }

  /** 登录名：字母开头、只用字母数字，带本次跑的唯一前缀；收尾时靠 `madeUsers` 记的 id */
  private String username(String suffix) {
    return "pa" + stamp + suffix;
  }

  private static String display(String username) {
    return "探针" + username;
  }

  /** 造一个真实账号：真散列、真角色。返回 id（收尾要按它清库） */
  private long makeUser(String username, String password, String role, boolean enabled) {
    jdbc.sql("""
        INSERT INTO sys_user (username, password_hash, display_name, role_code, enabled)
        VALUES (:u, :h, :d, :r, :e)
        """)
        .param("u", username)
        .param("h", encoder.encode(password))
        .param("d", display(username))
        .param("r", role)
        .param("e", enabled ? 1 : 0)
        .update();
    final long id = userId(username);
    madeUsers.add(id);
    return id;
  }

  private static Map<String, Object> userBody(String username, String role, String password) {
    final Map<String, Object> body = new LinkedHashMap<>();
    body.put("username", username);
    body.put("displayName", display(username));
    body.put("roleCode", role);
    body.put("password", password);
    return body;
  }

  private static Map<String, Object> saveBody(int rev, String name) {
    final Map<String, Object> body = new LinkedHashMap<>();
    body.put("rev", rev);
    body.put("name", name);
    body.put("state", room(8, 6, 2.8));
    body.put("note", "越权判据");
    return body;
  }

  /** 一份最小可用的房间状态（与前端提交的形状一致：宽 / 深 / 高 / 墙 / 设备） */
  private static Map<String, Object> room(int w, int d, double h) {
    final Map<String, Object> state = new LinkedHashMap<>();
    state.put("w", w);
    state.put("d", d);
    state.put("h", h);
    state.put("walls", List.of());
    state.put("items", List.of());
    return state;
  }

  private long createScheme(AuthProbe p, String name) {
    final AuthProbe.Res res = p.post("/api/schemes", Map.of("name", name, "state", room(8, 6, 2.8)));
    assertEquals(201, res.status(), "建方案要 201：" + res.body());
    final long id = longOf(res.json().get("id"));
    madeSchemes.add(id);
    return id;
  }

  private long userId(String username) {
    return jdbc.sql("SELECT id FROM sys_user WHERE username = :u").param("u", username)
        .query(Long.class).single();
  }

  private String hashOf(String username) {
    return jdbc.sql("SELECT password_hash FROM sys_user WHERE username = :u").param("u", username)
        .query(String.class).single();
  }

  private Map<String, Object> userRow(long id) {
    return jdbc.sql("SELECT * FROM sys_user WHERE id = :id").param("id", id)
        .query().listOfRows().get(0);
  }

  private Map<String, Object> schemeRow(long id) {
    return jdbc.sql("SELECT * FROM scheme WHERE id = :id").param("id", id)
        .query().listOfRows().get(0);
  }

  private long count(String sql, long id) {
    return jdbc.sql(sql).param("id", id).query(Long.class).single();
  }

  private long count(String sql, String username) {
    return jdbc.sql(sql).param("u", username).query(Long.class).single();
  }

  private static long longOf(Object v) {
    return ((Number) v).longValue();
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> map(Object v) {
    return (Map<String, Object>) v;
  }

  /** `[{id, ...}, ...]` → `{id: 行}`：判据里按 id 点名，比按位置取更禁得住别的账号的行插进来 */
  @SuppressWarnings("unchecked")
  private static Map<Long, Map<String, Object>> byId(Object rows) {
    final Map<Long, Map<String, Object>> out = new LinkedHashMap<>();
    for (final Object o : (List<Object>) rows) {
      final Map<String, Object> row = (Map<String, Object>) o;
      out.put(longOf(row.get("id")), row);
    }
    return out;
  }

  private static String contentTypeOf(AuthProbe.Res res) {
    final String ct = res.header("content-type");
    return ct == null ? "" : ct.split(";")[0].trim();
  }
}
