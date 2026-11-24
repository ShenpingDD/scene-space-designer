package com.scene.spatial.scheme;

import java.security.SecureRandom;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Random;

/**
 * Share —— 只读分享口令的**判据**（纯函数，可单测；不碰库、不碰 HTTP）
 *
 * ## 这件事的边界（写在最前面，因为它决定了后面所有代码）
 *
 * 分享出去的是**"看"的权利**，不是某一版内容 —— 表里就没有 `rev` 列（`V1` 建表时就这形状，
 * `docs/32` §3.3 写着"表已支持"）。所以界面必须说清楚：**打开链接看到的是当前内容**，
 * 原方案后来改了，这份链接看到的就是改后的样子。不说清楚，客户会拿两个月前的截图来对账。
 *
 * ## 口令为什么要挑字符
 *
 * 客户会把口令抄在纸上、在电话里念。`0/o`、`1/l/i` 这几对抄错一次，现场得到的只是
 * 一句"链接打不开"，**两边都不明白为什么**。去掉 4 个字符换来的是"念了就能抄对"。
 *
 * ## 为什么"不能用"要分三种
 *
 * 过期 / 被撤销 / 压根不存在 —— 这三件事给人的下一步动作完全不同
 * （找分享人要一个新的 / 问为什么被撤了 / 检查是不是抄错了）。
 * 合并成一句"链接无效"就等于把三份工作丢给用户自己猜（老规矩：不怕说不清，就怕含糊）。
 */
public final class Share {

  /**
   * 口令长度 = **8**（`V13` 把建表时的 `CHAR(32)` 放成了 `VARCHAR(32)`）。
   *
   * ## 为什么是 8 位，不是原来的 32 位
   *
   * 分享链接要能被**念出来、抄下来、印在二维码上**，长度是实打实的成本。
   * 但短口令是**公开可访问**的（免登录），所以长度只有一条约束：**不能被枚举**。
   * 去歧义字符集 31 个字符 → 31⁸ ≈ **8500 亿（≈2⁴⁰）**：实用上扫不动。
   *
   * ⚠️ **6 位不够**：31⁶ ≈ 8.9 亿（≈2³⁰）—— 在一个免登录、且**没有任何限流**的接口上，
   * 这个量级是**能被脚本扫出来的**（账在 `docs/55` §12.3）。要再缩短，
   * 得先给 `/api/share/*` 加限流，而不是直接减位数。
   */
  public static final int TOKEN_CHARS = 8;

  /** 默认有效期（天）—— `days` 不传时用它 */
  public static final int DEFAULT_DAYS = 30;
  /** 自定义上限（天）。三档之外仍允许 1..365 */
  public static final int MAX_DAYS = 365;

  /**
   * 「不过期」这一档（`days = 0`）。
   *
   * ⚠️ 这条**改过一次拍板**：原先刻意不给（理由：*一条永不失效的免登录链接，
   * 只在有人记得它存在的时候才是安全的*，见 `docs/43`）。用户 2026-10-08 决定提供这一档
   * （现场确有「这台设备的方案要长期挂在客户那儿」的用法）。
   * 风险与缓解一起记在 `docs/55` §12.2：位数从 32 降到 8 是**真实的降级**，
   * 所以平永久档必须配 8 位码（不能是 6 位）。
   */
  public static final int DAYS_PERMANENT = 0;

  /** 界面上给的三档（顺序 = 展示顺序）。**服务端是唯一来源**：界面照它渲染，不自己再写一份 */
  public static final List<Integer> DAY_CHOICES = List.of(7, 30, DAYS_PERMANENT);

  /**
   * 口令字符集：只留**无歧义**的字符（小写字母里去掉 `i` `l` `o`，数字里去掉 `0` `1`）。
   * 31 个字符 × 8 位 ≈ 2⁴⁰ —— 见上面 `TOKEN_CHARS` 的账。
   */
  private static final String ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

  private static final DateTimeFormatter FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");

  private Share() {
  }

  /** `scheme_share` 的一行 */
  public record Row(long id, long schemeId, String token, LocalDateTime expiresAt, boolean revoked,
                    long createdBy, LocalDateTime createdAt) {
  }

  /** 口令的三种状态（`VALID` 之外两种：**过期**与**已撤销**，原因不同）。「查不到这个口令」不在这三种里 —— 它连 `Row` 都拿不到，由调用方分别处理 */
  public enum State { VALID, EXPIRED, REVOKED }

  public static State stateOf(Row r, LocalDateTime now) {
    if (r.revoked()) {
      return State.REVOKED;
    }
    // `expires_at` 为 NULL = **不过期**（建表时的定义）。写成"立刻过期"会是个很难查的错：
    // 新建的口令全是坏的，而代码看起来完全正常。
    if (r.expiresAt() != null && !now.isBefore(r.expiresAt())) {
      return State.EXPIRED;
    }
    return State.VALID;
  }

  public static boolean ok(Row r, LocalDateTime now) {
    return stateOf(r, now) == State.VALID;
  }

  /** 机器可读的码（与 `ApiProblem` 的 reason 同口径，界面按它分流） */
  public static String codeOf(State s) {
    return switch (s) {
      case VALID -> "ok";
      case EXPIRED -> "share-expired";
      case REVOKED -> "share-revoked";
    };
  }

  /** 人话。三种原因必须长得不一样，否则界面分流了也没用 */
  public static String whyText(State s, LocalDateTime expiresAt) {
    return switch (s) {
      case VALID -> "可以用";
      case EXPIRED -> "已经过期（" + fmt(expiresAt) + " 到期）";
      case REVOKED -> "已经被人撤销";
    };
  }

  /** 有效期档的人话（界面与留痕共用一份，不在两处各写一遍） */
  public static String daysText(int days) {
    return days <= 0 ? "不过期" : days + " 天";
  }

  /** 有效期说明 —— `NULL` 要写成「不过期」，不能留空（留空看起来像"没有有效期"，正好说反） */
  public static String expiryText(LocalDateTime expiresAt) {
    return expiresAt == null ? "不过期" : "到 " + fmt(expiresAt);
  }

  public static String fmt(LocalDateTime t) {
    return t == null ? "" : t.format(FMT);
  }

  public static String newToken(Random rnd) {
    final StringBuilder sb = new StringBuilder(TOKEN_CHARS);
    for (int i = 0; i < TOKEN_CHARS; i++) {
      sb.append(ALPHABET.charAt(rnd.nextInt(ALPHABET.length())));
    }
    return sb.toString();
  }

  public static String newToken() {
    return newToken(new SecureRandom());
  }

  /**
   * 长得像我们的口令才去查库。
   *
   * ⚠️ 但**不要**用它给用户解释"为什么不对"：`不是 8 位`/`含非法字符` 是我们的规则，
   * 用户看到的应该是一句"这个口令对不上"——多说一句规则，就是在教人猜口令。
   */
  public static boolean looksLikeToken(String t) {
    if (t == null || t.length() != TOKEN_CHARS) {
      return false;
    }
    for (int i = 0; i < t.length(); i++) {
      if (ALPHABET.indexOf(t.charAt(i)) < 0) {
        return false;
      }
    }
    return true;
  }

  /** 过期时间。`days <= 0` = 不过期（即 `DAYS_PERMANENT`，界面上是一档） */
  public static LocalDateTime expiryFrom(int days, LocalDateTime now) {
    return days <= 0 ? null : now.plusDays(days);
  }

  /**
   * 只读页的地址（**相对路径**：服务端不知道对外是什么域名，拼完整链接是浏览器的事）。
   *
   * 形状是 `/view/<口令>`（U1 起用的是 `vue-router` 的 history 模式，地址里没有 `#`）。
   *
   * ⚠️ 这是一份**副本**：地址形状的唯一出处在前端 `app/src/router.js` 的 `shareHref()`
   * （拼地址的其实是前端）。两份写法容易漂，所以配了一条漂移判据：
   * `ShareLinkFormatDriftTest` —— 它读 `router.js` 对一遍，改了那边忘了这边就红。
   */
  public static String linkPath(String token) {
    return "/view/" + token;
  }
}
