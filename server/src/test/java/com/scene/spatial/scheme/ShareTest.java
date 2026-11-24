package com.scene.spatial.scheme;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Random;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ShareTest —— 分享口令的**判据**（纯函数，不碰库、不碰 HTTP）
 *
 * 这一层最值得钉住的不是"能生成口令"，而是那些**看起来像细节、错了却无法从界面看出来**
 * 的地方：
 *
 *   · `expires_at = NULL` 是**不过期**，不是"立刻过期"—— 写反了新建的口令全是坏的，
 *     而代码读起来完全正常；
 *   · 到期那一刻算不算过期（边界）——
 *   · 口令字符集里**必须没有** `0/o/1/l/i`：客户会在电话里念这串东西，
 *     抄错一次现场只会得到"链接打不开"，两边都不明白为什么；
 *   · 三种"不能用"的话**必须两两不同** —— 合并成一句"链接无效"，用户就得自己猜下一步
 *     （找分享人要新的？问为什么被撤了？还是自己抄错了？）。
 */
class ShareTest {

  private static final LocalDateTime NOW = LocalDateTime.of(2026, 9, 30, 16, 30);

  private static Share.Row row(String token, LocalDateTime expiresAt, boolean revoked) {
    return new Share.Row(1L, 2L, token, expiresAt, revoked, 1L, NOW.minusDays(1));
  }

  @Test
  @DisplayName("口令：8 位、只用无歧义字符、两次不同")
  void token_shape() {
    final String t = Share.newToken(new Random(42));
    assertEquals(8, Share.TOKEN_CHARS, "8 位：6 位只有 31^6 ≈ 8.9 亿，免登录 + 无任何限流的接口上能被扫");
    assertEquals(Share.TOKEN_CHARS, t.length(), "长度必须放得进 V13 的 VARCHAR(32)");
    assertTrue(Share.looksLikeToken(t), "自己生成的口令必须认得出：" + t);
    assertNotEquals(Share.newToken(), Share.newToken(), "两次生成撞上就说明随机源没在工作");
  }

  @Test
  @DisplayName("⭐ 短码更容易撞：2 万个口令不许出现重复（随机源一退化，这里就得红）")
  void token_no_collisions() {
    // 31^8 ≈ 8.5e11 —— 抽 2 万次撞上的概率约 1e-7。
    // 这条防的不是"运气差"，是**随机源退化成常量/短种子**（短码之后一个坏种子真的会撞）。
    final java.util.Set<String> seen = new java.util.HashSet<>();
    final Random rnd = new Random(20261008);
    for (int i = 0; i < 20_000; i++) {
      assertTrue(seen.add(Share.newToken(rnd)), "第 " + i + " 个口令撞了");
    }
  }

  @Test
  @DisplayName("⚠️ 易混字符必须真的不在字符集里（电话里念得清才抄得对）")
  void token_avoids_confusable_chars() {
    // 用同一个种子生成一大串，逐字符查这 5 个"看/听起来像"的字符一次都不该出现。
    // 这条不是在测实现，是在测**词表**：有人后来把字符集改成 `[0-9a-z]`，这里立刻红。
    final Random rnd = new Random(7);
    final StringBuilder all = new StringBuilder();
    for (int i = 0; i < 200; i++) {
      all.append(Share.newToken(rnd));
    }
    final String charset = all.toString();
    for (final char bad : new char[] { '0', 'o', '1', 'l', 'i' }) {
      assertEquals(-1, charset.indexOf(bad), "口令字符集里不该出现易混字符 '" + bad + "'");
    }
    assertFalse(Share.looksLikeToken("o".repeat(Share.TOKEN_CHARS)), "全 'o' 的口令必须不认");
    assertFalse(Share.looksLikeToken("0".repeat(Share.TOKEN_CHARS)), "全 '0' 的口令必须不认");
  }

  @Test
  @DisplayName("looksLikeToken：长度与字符都要对（大写也不收 —— 我们生成的只有小写）")
  void looksLikeToken_rules() {
    assertFalse(Share.looksLikeToken(null));
    assertFalse(Share.looksLikeToken(""), "空串");
    assertFalse(Share.looksLikeToken(Share.newToken().substring(0, Share.TOKEN_CHARS - 1)), "短一位");
    assertFalse(Share.looksLikeToken(Share.newToken() + "a"), "长一位");
    assertFalse(Share.looksLikeToken(Share.newToken().toUpperCase()), "大写不收");
    assertFalse(Share.looksLikeToken("abc defg".substring(0, Share.TOKEN_CHARS)), "带空格");
    // ⭐ 老口令（32 位）必须**不认**：这就是"改版后旧链接打不开"那条真话的底层判据。
    //   若哪天有人为了让老链接重新能用而放宽校验，这条会红 —— 那时必须同时把
    //   「旧链接可以复活」写进界面，否则界面就在说假话。
    assertFalse(Share.looksLikeToken("a".repeat(32)), "32 位老口令不再放行");
  }

  @Test
  @DisplayName("⭐ expires_at 为 NULL = 不过期 —— 现在它是界面上的一个**档**（7 / 30 / 不过期）")
  void null_expiry_means_never() {
    final Share.Row never = row(Share.newToken(), null, false);
    assertEquals(Share.State.VALID, Share.stateOf(never, NOW));
    assertEquals("不过期", Share.expiryText(null));
    assertNull(Share.expiryFrom(0, NOW), "days=0（DAYS_PERMANENT）= 不过期");
    assertNull(Share.expiryFrom(Share.DAYS_PERMANENT, NOW));
    // 三档与它们的人话：界面那一排按钮的来源（**服务端是唯一来源**，界面不自己写一份）
    assertEquals(List.of(7, 30, 0), Share.DAY_CHOICES, "界面上的三档：7 / 30 / 不过期");
    assertEquals("7 天", Share.daysText(7));
    assertEquals("30 天", Share.daysText(30));
    assertEquals("不过期", Share.daysText(Share.DAYS_PERMANENT));
    // 按取消的 90 档：它仍是可以传的自定义天数（1..365），但**不在三档里**
    assertFalse(Share.DAY_CHOICES.contains(90), "90 天这一档已被取消（换成「不过期」）");
  }

  @Test
  @DisplayName("到期边界：到点那一刻就算过期（不是再多给一秒）")
  void expiry_boundary() {
    final LocalDateTime exp = NOW.plusMinutes(1);
    assertEquals(Share.State.VALID, Share.stateOf(row(Share.newToken(), exp, false), NOW));
    assertEquals(Share.State.EXPIRED,
        Share.stateOf(row(Share.newToken(), exp, false), exp), "正好到点 → 已过期");
    assertEquals(Share.State.EXPIRED,
        Share.stateOf(row(Share.newToken(), exp, false), exp.plusSeconds(1)), "过了 1 秒 → 已过期");
    assertEquals(NOW.plusDays(30), Share.expiryFrom(30, NOW), "expiryFrom(30) 应当是 now + 30 天");
  }

  @Test
  @DisplayName("撤销压过一切：哪怕还没到期")
  void revoked_wins() {
    final Share.Row r = row(Share.newToken(), NOW.plusDays(30), true);
    assertEquals(Share.State.REVOKED, Share.stateOf(r, NOW));
    assertFalse(Share.ok(r, NOW));
  }

  @Test
  @DisplayName("⭐ 三种不能用必须三种不同的话（合并就等于让用户自己猜）")
  void three_reasons_are_three_sentences() {
    final String expired = Share.whyText(Share.State.EXPIRED, NOW.plusDays(-1));
    final String revoked = Share.whyText(Share.State.REVOKED, null);
    final String valid = Share.whyText(Share.State.VALID, null);
    assertEquals(3, List.of(expired, revoked, valid).stream().distinct().count(),
        "三句话必须两两不同，实际：" + expired + " / " + revoked + " / " + valid);
    assertTrue(expired.contains("过期"), "过期要说清过期，还要带上时间：" + expired);
    assertTrue(revoked.contains("撤销"), revoked);
    assertEquals("share-expired", Share.codeOf(Share.State.EXPIRED));
    assertEquals("share-revoked", Share.codeOf(Share.State.REVOKED));
    assertEquals("ok", Share.codeOf(Share.State.VALID));
  }

  @Test
  @DisplayName("只读页地址：相对路径走 `/view/`（真实路径：与前端路由表同一个形状）")
  void link_path() {
    final String t = Share.newToken(new Random(1));
    assertEquals("/view/" + t, Share.linkPath(t));
    assertTrue(Share.linkPath(t).startsWith("/view/"),
        "与 router.js 的路由表同一个形状（前端那边同样拼 '/view/' + token）");
    assertFalse(Share.linkPath(t).startsWith("http"), "不能在这里造绝对地址");
  }
}