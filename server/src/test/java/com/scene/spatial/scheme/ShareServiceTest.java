package com.scene.spatial.scheme;

import com.scene.spatial.admin.AdminRepository;
import com.scene.spatial.admin.AdminService;
import com.scene.spatial.admin.AuditLogInMemory;
import com.scene.spatial.api.ApiProblem;
import com.scene.spatial.auth.CurrentUser;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ShareServiceTest —— 分享这一层的**行为**判据（不碰 HTTP，两个内存实现）
 *
 * 钉住 2026-10-08 用户拍板的两件事，以及一件**行为变更**：
 *
 *   ① **一个方案只留一条有效链接**（设计决策记录 §12.2）：建新的之前先把旧的撤掉，
 *      而且**双向判据** —— 新的能用 **且** 旧的真的不能用了（只查一侧会替问题签单，D49）；
 *   ② **永久档**（`days = 0`）：`expires_at` 为 NULL，客户端看到的也是「不过期」；
 *   ③ 有效期**只有三档**（7 / 30 / 不过期），90 档已被取消 —— 但 90 仍是合法输入
 *      （1..365 的任意天数），所以这里不给它发 400，只把它从选择列表里拿掉。
 *
 * ## 为什么「自动替换」也要查审计
 *
 * 客户手里那条链接**突然**失效，以后一定会有人问「谁撤的、什么时候」。
 * 「系统自己撤的」也是一次撤销动作，也得留得下痕迹 —— 所以这条有断言。
 */
class ShareServiceTest {

  /** 方案归属的账号 id（与 `CurrentUser` 的 `off` 档固定身份同号：这一档里"我"永远是 1） */
  private static final long OWNER = 1L;

  /**
   * 测试用的最小 `ObjectProvider`（生产里由 Spring 给；写法照 `ParamsSourceTest` 的最小 provider）。
   * 递 `null` = 这一档没有库 → `AdminService.userNames()` 是空表 →
   * 免登录页上的"谁分享的"回落到 `#<id>`（不编名字）。
   */
  private record NoRepo(AdminRepository repo) implements ObjectProvider<AdminRepository> {
    @Override
    public AdminRepository getObject() {
      return repo;
    }

    @Override
    public AdminRepository getObject(Object... args) {
      return repo;
    }

    @Override
    public AdminRepository getIfAvailable() {
      return repo;
    }

    @Override
    public AdminRepository getIfUnique() {
      return repo;
    }
  }

  private record Rig(AuditLogInMemory audit, ShareService svc, long schemeId) {
  }

  private static Rig rig() {
    final SchemeStoreInMemory schemes = new SchemeStoreInMemory();
    final ShareStoreInMemory shares = new ShareStoreInMemory();
    final AuditLogInMemory audit = new AuditLogInMemory();
    // 身份取 `off` 档的固定值（id=1 / local）：本测试不拉 Spring，也不需要登录流程 ——
    // 分享服务要的只是"现在是谁"，而这一档给的就是确定的那个答案。
    final CurrentUser user = new CurrentUser("off");
    final AdminService admin = new AdminService(new NoRepo(null), user);
    final Map<String, Object> state = new LinkedHashMap<>();
    state.put("w", 8);
    state.put("d", 6);
    state.put("h", 2.8);
    state.put("walls", List.of());
    state.put("items", List.of());
    final SchemeStore.SchemeRow row = schemes.create(OWNER, "分享服务探针", state, "1", 1, null);
    return new Rig(audit, new ShareService(schemes, shares, audit, user, admin), row.id());
  }

  private static List<?> list(Object v) {
    return (List<?>) v;
  }

  private static Map<?, ?> map(Object v) {
    return (Map<?, ?>) v;
  }

  @Test
  @DisplayName("⭐ 一个方案只留一条有效链接：建新的 → 旧的立刻失效（双向：新的能用 且 旧的不能用）")
  void oneLinkOnly() {
    final Rig r = rig();

    final Map<String, Object> first = r.svc().create(r.schemeId(), 30);
    final String t1 = String.valueOf(first.get("token"));
    assertEquals(0, list(first.get("replaced")).size(), "第一条时没有旧链接要撤");
    assertEquals("", first.get("replacedText"));
    assertEquals("分享服务探针", String.valueOf(r.svc().resolve(t1).get("name")),
        "第一条口令能读到方案（这是「双向」里的正向）");

    final Map<String, Object> second = r.svc().create(r.schemeId(), 7);
    final String t2 = String.valueOf(second.get("token"));
    assertNotEquals(t1, t2, "重新打开 = **换一条新口令**（不做「同一条复活」）");
    assertEquals(1, list(second.get("replaced")).size(), "旧的那条被自动撤掉");
    assertTrue(String.valueOf(second.get("replacedText")).contains("旧链接"),
        "要把「旧链接已失效」说出来：" + second.get("replacedText"));
    assertEquals("分享服务探针", String.valueOf(r.svc().resolve(t2).get("name")), "新口令能用");

    // ⭐ 反向：旧链接必须**不能**用了，而且原因要说成「被撤销」（客户才知道去找分享人要新的）
    final ApiProblem gone = assertThrows(ApiProblem.class, () -> r.svc().resolve(t1));
    assertEquals("share-revoked", gone.reason(), "旧链接按「被撤销」告诉客户，而不是含糊的「对不上」");
    assertEquals(410, gone.status(), "410：东西存在过、现在没了（与 404「抄错了」区分开）");

    // 列表：只剩一条活着的，历史那条仍在（留痕不删行）
    final Map<String, Object> listed = r.svc().listOf(r.schemeId());
    assertEquals(1, listed.get("alive"), "一个方案只留一条有效链接");
    assertEquals(2, list(listed.get("list")).size(), "历史那条仍在（撤销是 UPDATE，不是 DELETE）");
    assertEquals(t2, map(listed.get("current")).get("token"),
        "current = 最新那条（界面那个开关控制的就是它）");
  }

  @Test
  @DisplayName("⭐ 永久档（days=0）：expires_at 为 NULL，客户看到的也写「不过期」")
  void permanentTier() {
    final Rig r = rig();
    final Map<String, Object> m = r.svc().create(r.schemeId(), 0);
    assertNull(m.get("expiresAt"), "永久 = expires_at 为 NULL（库里 NULL 就是不过期）");
    assertEquals("不过期", m.get("expiresText"));
    assertEquals(Boolean.TRUE, m.get("ok"), "永久 = 现在就能用");

    final Map<String, Object> read = r.svc().resolve(String.valueOf(m.get("token")));
    assertEquals("不过期", map(read.get("share")).get("expiresText"),
        "客户那一页也要写「不过期」—— 留空看起来像「没有有效期」，正好说反");
  }

  @Test
  @DisplayName("有效期：越界给 bad-share-days（不是静默改成 30）；90 天仍合法但不在三档里")
  void badDays() {
    final Rig r = rig();
    assertEquals("bad-share-days",
        assertThrows(ApiProblem.class, () -> r.svc().create(r.schemeId(), 400)).reason(),
        "超过 MAX_DAYS 要明确报错");
    assertEquals("bad-share-days",
        assertThrows(ApiProblem.class, () -> r.svc().create(r.schemeId(), -5)).reason(),
        "负数不是「永久」—— 永久是明确的 0（静默当永久就是把一次手滑当成了决定）");

    final Map<String, Object> c = r.svc().create(r.schemeId(), 90);
    assertEquals(Boolean.TRUE, c.get("ok"), "90 天是合法输入（不在三档里，但不是错误）");

    final List<?> choices = list(r.svc().listOf(r.schemeId()).get("dayChoices"));
    assertEquals(3, choices.size(), "三档：7 / 30 / 不过期");
    assertEquals(7, map(choices.get(0)).get("days"));
    assertEquals("7 天", map(choices.get(0)).get("text"));
    assertEquals(30, map(choices.get(1)).get("days"));
    assertEquals("30 天", map(choices.get(1)).get("text"));
    assertEquals(0, map(choices.get(2)).get("days"));
    assertEquals("不过期", map(choices.get(2)).get("text"));
  }

  @Test
  @DisplayName("自动替换也要留痕：audit_log 里查得到「谁、什么时候、为什么」")
  void autoReplaceIsAudited() {
    final Rig r = rig();
    r.svc().create(r.schemeId(), 30);
    r.svc().create(r.schemeId(), 30);
    final List<Map<String, Object>> log =
        r.audit().listFor("scheme", String.valueOf(r.schemeId()));
    assertEquals(1, log.size(), "自动撤掉旧链接也是一次撤销动作 → 必须留痕");
    assertEquals("scheme.share-revoke", log.get(0).get("action"));
    assertTrue(String.valueOf(log.get(0).get("detail_json")).contains("一个方案只留一条"),
        "留痕里要写清为什么撤的：" + log.get(0).get("detail_json"));
    assertTrue(String.valueOf(log.get(0).get("detail_json")).contains("tokenTail"),
        "只留口令后 4 位（完整口令不进日志）");
  }

  @Test
  @DisplayName("撤销这一条 = 关闭分享：再访问得到 410 +「已经被撤销」；再撤一次不报错")
  void revokeIsClose() {
    final Rig r = rig();
    final Map<String, Object> m = r.svc().create(r.schemeId(), 7);
    final long shareId = ((Number) m.get("id")).longValue();
    final String token = String.valueOf(m.get("token"));

    final Map<String, Object> revoked = r.svc().revoke(r.schemeId(), shareId, "客户看完了");
    assertEquals(Boolean.TRUE, revoked.get("changed"));
    assertTrue(String.valueOf(revoked.get("how")).contains("已撤销"),
        "要告诉分享人「已经撤了」：" + revoked.get("how"));
    assertTrue(String.valueOf(revoked.get("how")).contains("打不开"),
        "还要说清后果（客户端立刻打不开）：" + revoked.get("how"));
    assertEquals(0, r.svc().listOf(r.schemeId()).get("alive"), "关掉之后没有活着的链接");

    final ApiProblem gone = assertThrows(ApiProblem.class, () -> r.svc().resolve(token));
    assertEquals("share-revoked", gone.reason());

    // 再撤一次：他要的结果已经在了 → 说清楚，不报错（与 SchemeService.restore 同一条纪律）
    final Map<String, Object> again = r.svc().revoke(r.schemeId(), shareId, null);
    assertEquals(Boolean.FALSE, again.get("changed"));
    assertTrue(String.valueOf(again.get("how")).contains("本来就是撤销状态"));
  }
}