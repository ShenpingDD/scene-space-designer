package com.scene.spatial.scheme;

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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * RenameSchemeTest —— `PATCH /api/schemes/{id}/name` 的服务端判据（验收 第二轮）
 *
 * ## 这条端点要守住的三句话
 *
 * ① **改名不是保存**：`rev` 不变、`scheme_revision` 一行都不多、`room_json` 一个字都不动。
 *    写成"保存一个只有名字的 body"的话，一次改名会悄悄多出一版 —— 版本列表与回滚都会跟着变糊。
 * ② **不存在与别人的方案都是 404**（与 `PUT /api/schemes/{id}` 同口径），
 *    不是 403、也不是 200：别人的方案在这里就是不存在。
 * ③ **非法名称是 400，而且什么都没写**：空 / 纯空格 / 超过 128 字。
 *    400 之后回库 `SELECT` 一次 —— 否则"报错了但库被改了"这种半截状态没人看得见。
 *
 * ## 为什么要真登录、真库
 *
 * 413 的 401/403 与归属判断都发生在安全链与存储层的条件更新里，换成替身身份会把两件事一起绕过去；
 * `scheme_revision` 的行数也只能回库数（接口不回它，回它就是给前端多一个不该依赖的字段）。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestPropertySource(properties = {
    // LOD 后台作业在测试里是要写盘写库的副作用，关掉：这条判据只关心改名这一条写路径
    "spatial.lod.enabled=false"
})
class RenameSchemeTest {

  /** 造出来的账号统一用这个口令（登录路径真的会走 BCrypt 校验） */
  private static final String PW = "probe-rename-9";

  /** 128 字上限：多一个字就必须是 400 */
  private static final int MAX_NAME = 128;

  @Value("${local.server.port}")
  private int port;

  @Autowired
  private JdbcClient jdbc;

  @Autowired
  private PasswordEncoder encoder;

  /** 本次跑造出来的账号与方案（收尾按外键顺序清掉；`scheme_revision` 由外键 CASCADE 带走） */
  private final List<Long> madeUsers = new ArrayList<>();
  private final List<Long> madeSchemes = new ArrayList<>();

  private final String stamp = Long.toString(Math.abs(System.nanoTime() % 1_000_000L));

  /** 方案的主人（admin：写方案的门是开的） */
  private AuthProbe owner;

  /** 另一个人（designer：也能写方案，但不是这些方案的 owner） */
  private AuthProbe other;

  /** 只读角色：用来证明这条端点用的是「写方案」那道门 */
  private AuthProbe viewer;

  @BeforeEach
  void signIn() {
    owner = signInAs("a", "admin");
    other = signInAs("b", "designer");
    viewer = signInAs("v", "viewer");
  }

  @AfterEach
  void cleanUp() {
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

  @Test
  @DisplayName("⭐ 改名成功：rev 不变、版本记录不多一行、内容一个字都不动")
  void renameKeepsRevAndWritesNoRevision() {
    final long id = createScheme(owner, "库房原名");

    // 先真保存一次：让 rev 与历史都不是"空的初始态"——否则"没多写历史"判不出来
    final AuthProbe.Res saved = owner.put("/api/schemes/" + id,
        Map.of("rev", 1, "name", "库房原名", "state", room(9, 7, 3.0)));
    assertEquals(200, saved.status(), "先保存一次，好让 rev 与版本历史都有内容：" + saved.body());
    assertEquals(2, revOf(id), "保存后 rev 应当是 2");
    final int revsBefore = revisionCount(id);
    assertTrue(revsBefore >= 2, "保存后版本历史至少两条（创建 + 这次保存），实际：" + revsBefore);

    final AuthProbe.Res res = owner.patch("/api/schemes/" + id + "/name",
        Map.of("name", "库房新名"));
    assertEquals(200, res.status(), "改名应当成功：" + res.body());
    final Map<String, Object> body = res.json();
    assertEquals(Boolean.TRUE, body.get("ok"), "响应沿用 ok 包装：" + res.body());
    assertEquals(id, longOf(body.get("id")), "响应里的 id 就是这份方案");
    assertEquals("库房新名", body.get("name"), "响应带新名字");
    assertEquals(2, longOf(body.get("rev")), "**rev 原样带回：改名不产生新版本**");

    // 回库核对（不信响应自己的话）
    assertEquals("库房新名", nameOf(id), "库里那一行的 name 真的变了");
    assertEquals(2, revOf(id), "库里的 rev 一动没动");
    assertEquals(revsBefore, revisionCount(id), "**version 记录一行都不许多**（多一行就是又偷偷存了一版）");
    assertEquals(9, widthOf(id), "room_json 一个字都不许动（改名不是内容编辑）");

    // 再读一次接口：改名之后 GET 看到的是新名字、旧 rev
    final AuthProbe.Res got = owner.get("/api/schemes/" + id);
    assertEquals(200, got.status(), got.body());
    assertEquals("库房新名", got.json().get("name"), "GET 读到的是新名字");
    assertEquals(2, longOf(got.json().get("rev")), "GET 读到的 rev 还是 2");
    assertEquals(9, longOf(((Map<?, ?>) got.json().get("state")).get("w")), "GET 读到的内容没有被改名碰到");
  }

  @Test
  @DisplayName("空名 / 纯空格 / 超过 128 字：400，而且库里的名字一个字都没改")
  void illegalNamesAreRejectedWithoutWriting() {
    final long id = createScheme(owner, "原名不动");
    final List<String> bad = List.of("", "   ", "x".repeat(MAX_NAME + 1));
    for (final String name : bad) {
      final AuthProbe.Res res = owner.patch("/api/schemes/" + id + "/name", Map.of("name", name));
      assertEquals(400, res.status(),
          "非法名称应当是 400（长度 " + name.length() + "）：" + res.body());
      assertEquals("invalid-request", res.json().get("reason"),
          "非法名称的 reason 是 invalid-request（与新建方案同一条口径）：" + res.body());
      assertEquals("原名不动", nameOf(id),
          "400 之后库里必须还是原名（「报错了但库被改了」这种半截状态最坏）");
    }

    // 128 字整是合法的（边界要能过，否则"上限 128"就是 127）
    final String full = "名".repeat(MAX_NAME);
    final AuthProbe.Res ok = owner.patch("/api/schemes/" + id + "/name", Map.of("name", full));
    assertEquals(200, ok.status(), "128 字整应当成功：" + ok.body());
    assertEquals(MAX_NAME, nameOf(id).length(), "128 字整被原样存下");
  }

  @Test
  @DisplayName("⭐ 别人的方案与不存在的方案：都是 404，且名字没被改")
  void otherOwnersAndMissingSchemesAre404() {
    final long mine = createScheme(owner, "我的方案");
    final long theirs = createScheme(other, "别人的方案");

    assertEquals(404, owner.patch("/api/schemes/" + theirs + "/name",
        Map.of("name", "偷偷改名")).status(),
        "别人的方案按 id 直改 → 404（与 save 同口径：别人的方案在这里就是不存在）");
    assertEquals("别人的方案", nameOf(theirs), "别人的方案名字不许被动");

    assertEquals(404, other.patch("/api/schemes/" + mine + "/name",
        Map.of("name", "反向偷偷改名")).status(),
        "反向也一样：谁都不是谁的 owner");
    assertEquals("我的方案", nameOf(mine), "我的方案名字也不许被动");

    final long ghost = 987_654_321L;
    assertEquals(404, owner.patch("/api/schemes/" + ghost + "/name",
        Map.of("name", "不存在的方案")).status(),
        "不存在的 id → 404");
  }

  @Test
  @DisplayName("权限沿用「写方案」那道门：viewer 改名是 403，不是 404，也不是 200")
  void viewerCannotRename() {
    final long mine = createScheme(owner, "只读的人也改不了");
    final AuthProbe.Res res = viewer.patch("/api/schemes/" + mine + "/name",
        Map.of("name", "只读的人改的名字"));
    assertEquals(403, res.status(),
        "viewer 应当被写方案的门挡下（403）：门先于归属判断 —— " + res.body());
    assertEquals("forbidden", res.json().get("reason"), "403 的 reason 是 forbidden：" + res.body());
    assertEquals("只读的人也改不了", nameOf(mine), "被挡下之后名字一个字都没动");
  }

  @Test
  @DisplayName("未登录：401（不是 404，也不是被页面兜底成 200）")
  void anonymousCannotRename() {
    final long mine = createScheme(owner, "要登录才能改");
    final AuthProbe anon = new AuthProbe(port);
    // 先取一次令牌：不取的话 CSRF 过滤器会先挡成 403 bad-csrf，那样判到的只是"没有令牌"，
    // 而不是这一条要判的"没有登录"（真实界面启动时做的也是这一步，见 AuthProbe 类注释）
    anon.primeCsrf();
    final AuthProbe.Res res = anon.patch("/api/schemes/" + mine + "/name",
        Map.of("name", "匿名改的名字"));
    assertEquals(401, res.status(), "未登录应当是 401：「" + res.body() + "」");
    assertEquals("要登录才能改", nameOf(mine), "未登录的请求不产生任何写入");
  }

  // ───────────────────────────── 小工具 ─────────────────────────────

  private AuthProbe signInAs(String suffix, String role) {
    final String u = "rn" + stamp + suffix;
    jdbc.sql("""
        INSERT INTO sys_user (username, password_hash, display_name, role_code, enabled)
        VALUES (:u, :h, :d, :r, 1)
        """)
        .param("u", u)
        .param("h", encoder.encode(PW))
        .param("d", "改名探针 " + suffix)
        .param("r", role)
        .update();
    madeUsers.add(jdbc.sql("SELECT id FROM sys_user WHERE username = :u").param("u", u)
        .query(Long.class).single());
    final AuthProbe p = new AuthProbe(port);
    final AuthProbe.Res login = p.login(u, PW);
    assertEquals(200, login.status(), "造账号后要能真登录：" + login.body());
    return p;
  }

  private long createScheme(AuthProbe p, String name) {
    final AuthProbe.Res res = p.post("/api/schemes", Map.of("name", name, "state", room(8, 6, 2.8)));
    assertEquals(201, res.status(), "建方案要 201：" + res.body());
    final long id = longOf(res.json().get("id"));
    madeSchemes.add(id);
    return id;
  }

  private static Map<String, Object> room(int w, int d, double h) {
    final Map<String, Object> state = new LinkedHashMap<>();
    state.put("w", w);
    state.put("d", d);
    state.put("h", h);
    state.put("walls", List.of());
    state.put("items", List.of());
    return state;
  }

  private String nameOf(long id) {
    return jdbc.sql("SELECT name FROM scheme WHERE id = :id").param("id", id)
        .query(String.class).single();
  }

  private int revOf(long id) {
    return jdbc.sql("SELECT rev FROM scheme WHERE id = :id").param("id", id)
        .query(Integer.class).single();
  }

  private int revisionCount(long id) {
    return jdbc.sql("SELECT COUNT(*) FROM scheme_revision WHERE scheme_id = :id").param("id", id)
        .query(Integer.class).single();
  }

  /** 读 room_json 里的宽度：改名不该碰内容，用最直观的一项做探针 */
  private int widthOf(long id) {
    final Number w = jdbc.sql("SELECT room_json ->> '$.w' AS w FROM scheme WHERE id = :id")
        .param("id", id).query(Number.class).single();
    return w == null ? -1 : w.intValue();
  }

  private static long longOf(Object v) {
    return ((Number) v).longValue();
  }
}
