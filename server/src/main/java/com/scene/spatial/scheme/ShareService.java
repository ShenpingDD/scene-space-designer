package com.scene.spatial.scheme;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.scene.spatial.admin.AdminService;
import com.scene.spatial.admin.AuditLog;
import com.scene.spatial.api.ApiProblem;
import com.scene.spatial.auth.CurrentUser;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * ShareService -- 只读分享(`scheme_share`):生成 / 列出 / 撤销 / 免登录读
 *
 * ## 边界(写在最前面,它决定了后面所有代码)
 *
 * 分享出去的是**"看"的权利**,不是某一版内容 -- 表里没有 `rev` 列(`V1` 建表就这形状,
 * `docs/32` §3.3 写着"表已支持")。所以:**链接打开的是当前内容**。原方案后来改了,
 * 这份链接看到的就是改后的样子。界面必须把这句话说出来 -- 不说清楚,客户会拿两个月前的
 * 截图来对账,而两边都觉得自己没错。
 *
 * ## 四个动作,四种留痕口径
 *
 * | 动作 | 写 `audit_log` 吗 | 为什么 |
 * | --- | --- | --- |
 * | 生成口令 | **不写** | 口令列表本身就是记录(谁建的 / 什么时候 / 什么时候到期),再写一条是重复 |
 * | 撤销 | **写**(`scheme.share-revoke`) | 这是人为动作,而且"为什么撤"以后一定会有人问 |
 * | 列出 | 不写 | 读不算动作 |
 * | 免登录读 | **不写** | 它会被客户反复刷新;写进去就把日志淹了,而这条信息的价值极低 |
 *
 * ## 谁有资格看口令
 *
 * 列出 / 生成 / 撤销都要 `requireWriteSchemes` —— **口令是凭据**（谁拿到谁就能看方案），
 * 不是“关于方案的说明”。`viewer` 能看方案本身，但看不到别人发的口令。
 *
 * ## 一个方案只留一条有效链接（2026-10-08 用户拍板，`docs/55` §12.2）
 *
 * 以前允许一个方案发多条。那样必然长出「我明明关了，怎么还能打开」这类问题 ——
 * 界面说假话的典型形态（用户看到的是“关了”，而库里另一条还活着）。
 * 现在：**建新的之前先把还活着的撤掉**；“关” = 撤掉这一条；“再打开” = **换一条新口令**
 * （发出去过的口令复活，等于把访问权还给所有拿过它的人 —— 不做这件事）。
 */
@Service
public class ShareService {

  /** `audit_log.target_type` 的取值(与 `DeliveryService` 同口径) */
  private static final String TARGET_SCHEME = "scheme";

  /** 撤销的留痕动作名 */
  private static final String ACTION_REVOKE = "scheme.share-revoke";

  private static final ObjectMapper JSON = new ObjectMapper();

  private final SchemeStore schemes;
  private final ShareStore store;
  private final AuditLog audit;
  private final CurrentUser user;
  /** 账号目录：**免登录**那条路径要回答"谁分享的"，而那条路径上没有登录态可用 */
  private final AdminService admin;

  public ShareService(SchemeStore schemes, ShareStore store, AuditLog audit, CurrentUser user,
                      AdminService admin) {
    this.schemes = schemes;
    this.store = store;
    this.audit = audit;
    this.user = user;
    this.admin = admin;
  }

  /**
   * 方案必须存在(不存在就 404,而不是"生成了一条指向空气的口令")。
   *
   * 归属口径：**只能给自己名下的方案发口令**（`owner_id` 等于会话用户）。
   * 别人的方案在这里就是"不存在" —— 与全站越权读同一个口径，不新增 403 分支。
   */
  private SchemeStore.SchemeRow requireScheme(long schemeId) {
    return schemes.find(schemeId, user.id())
        .orElseThrow(() -> ApiProblem.notFound("方案不存在(或已被删除):id=" + schemeId));
  }

  /**
   * 免登录路径取方案：**归属由口令那一行记的分享人说了算**。
   *
   * 打开 `/view/<口令>` 的人没有登录态，所以这里不许读会话用户 ——
   * 口令本身就是凭据，而"这份方案属于谁"由发口令那一刻记下的 `createdBy` 回答。
   */
  private SchemeStore.SchemeRow requireSharedScheme(long schemeId, long ownerId) {
    return schemes.find(schemeId, ownerId)
        .orElseThrow(() -> ApiProblem.notFound(
            "这条分享链接指向的方案已经不在方案库里了 —— 找分享人重新发一条。"));
  }

  // ─────────────────────────── 1 生成 ───────────────────────────

  /**
   * 生成一条口令（= **打开分享**）。
   *
   * 一个方案只留一条有效链接：建新的之前，先把还活着的撤掉（见类注释）。
   * `days == null` = 默认 {@link Share#DEFAULT_DAYS} 天；
   * `days == 0` = **不过期**（`Share.DAYS_PERMANENT`）。
   *
   * ⚠️ 「不过期」这一档**改过一次拍板**：原先刻意不给（理由：一条永不失效的免登录链接，
   * 只在有人记得它存在的时候才是安全的）。2026-10-08 用户决定提供，风险与缓解见 `docs/55` §12.2。
   */
  public Map<String, Object> create(long schemeId, Integer days) {
    requireScheme(schemeId);
    final int d = days == null ? Share.DEFAULT_DAYS : days;
    if (d != Share.DAYS_PERMANENT && (d < 1 || d > Share.MAX_DAYS)) {
      throw ApiProblem.badRequest("bad-share-days",
          "有效期只有三档：7 天 / 30 天 / 不过期（收到 " + d + "）。");
    }
    final LocalDateTime now = LocalDateTime.now().withNano(0);
    // 先撤旧再建新：一个方案只留一条
    final List<Map<String, Object>> replaced =
        revokeAlive(schemeId, now, "重新生成分享链接：旧链接自动失效（一个方案只留一条）");
    Share.Row created = null;
    for (int i = 0; i < 3 && created == null; i++) {
      final String token = Share.newToken();
      // 撞了（概率小，但**短码之后这件事真会碰到**）→ 换一个再来。
      // 也顺手挡住将来某次改动把随机源换成常量这种事故。
      if (store.findByToken(token).isPresent()) {
        continue;
      }
      created = store.create(schemeId, token, Share.expiryFrom(d, now), user.id(), now);
    }
    if (created == null) {
      throw new IllegalStateException("连撞三次口令都重复 —— 这不该发生，请看一眼随机源");
    }
    final Map<String, Object> m = one(created, now, null);
    // 旧的被换掉了就要**说出来**：客户手里那条链接现在打不开了，
    // 分享人得知道这件事（不然下一个电话就是“你怎么给我个死链接”）。
    m.put("replaced", replaced);
    m.put("replacedText", replaced.isEmpty() ? ""
        : "已自动失效 " + replaced.size() + " 条旧链接 —— 一个方案只留一条最新链接。");
    return m;
  }

  /**
   * 把这份方案**还活着的**口令全撤掉，返回被撤掉的那几条（只留尾部，不留完整口令）。
   *
   * 虽然是“系统自己撤的”，但**照样写审计**：客户手里那条链接突然失效，
   * 以后一定会有人问“什么时候、为什么” —— 「系统自己撤的」也得留得下痕迹。
   */
  private List<Map<String, Object>> revokeAlive(long schemeId, LocalDateTime now, String why) {
    final List<Map<String, Object>> out = new ArrayList<>();
    for (final Share.Row r : store.listOf(schemeId)) {
      if (!Share.ok(r, now)) {
        continue;
      }
      store.revoke(schemeId, r.id());
      final Map<String, Object> detail = new LinkedHashMap<>();
      detail.put("shareId", r.id());
      detail.put("tokenTail", tail(r.token()));
      detail.put("why", why);
      audit.write(actorName(), ACTION_REVOKE, TARGET_SCHEME, String.valueOf(schemeId), json(detail));
      final Map<String, Object> m = new LinkedHashMap<>();
      m.put("id", r.id());
      m.put("tokenTail", tail(r.token()));
      out.add(m);
    }
    return out;
  }

  // ─────────────────────────── 2 列出 ───────────────────────────

  /**
   * 这份方案的**全部**口令（含已过期 / 已撤销 —— 界面自己标，服务端不替它筛）。
   *
   * 除了 `list`，还多给两样东西，都是为了“界面不用猜”：
   *   · `current` = **最新那条**（不论死活）—— 用户拍板一个方案只做 1 条链接，
   *     界面上那个开关控制的就是它；
   *   · `dayChoices` = 有效期三档（服务端是唯一来源，界面不自己写一份 —— 写两份就等着漂）。
   */
  public Map<String, Object> listOf(long schemeId) {
    requireScheme(schemeId);
    final LocalDateTime now = LocalDateTime.now().withNano(0);
    final List<Map<String, Object>> out = new ArrayList<>();
    int alive = 0;
    for (final Share.Row r : store.listOf(schemeId)) {
      final Map<String, Object> m = one(r, now, null);
      if (Boolean.TRUE.equals(m.get("ok"))) {
        alive++;
      }
      out.add(m);
    }
    final List<Map<String, Object>> choices = new ArrayList<>();
    for (final int d : Share.DAY_CHOICES) {
      final Map<String, Object> c = new LinkedHashMap<>();
      c.put("days", d);
      c.put("text", Share.daysText(d));
      choices.add(c);
    }
    final Map<String, Object> res = new LinkedHashMap<>();
    res.put("ok", true);
    res.put("now", Share.fmt(now));
    res.put("defaultDays", Share.DEFAULT_DAYS);
    res.put("maxDays", Share.MAX_DAYS);
    res.put("dayChoices", choices);
    // 「还有几条能用」是这一屏最该一眼看到的东西：一堆链接里混着一条已撤销的，
    // 不数出来就等于让用户自己数（而我们数得出）。
    res.put("alive", alive);
    res.put("list", out);
    // `list` 新的在前（两个实现都是）→ 第一条就是“现在这一条”
    res.put("current", out.isEmpty() ? null : out.get(0));
    return res;
  }

  // ─────────────────────────── 3 撤销 ───────────────────────────

  /**
   * 撤销一条口令。
   *
   * ⚠️ **"不存在"与"本来就是撤销状态"是两件事**(与 `SchemeService.restore` 那条纪律同源):
   * 双击、或者列表没刷新,都会走到"已经撤过了"。那时**不该报错** --
   * 他要的结果已经在了,说一句"不需要再撤"比回一句 409 有用得多。
   */
  public Map<String, Object> revoke(long schemeId, long shareId, String note) {
    requireScheme(schemeId);
    final LocalDateTime now = LocalDateTime.now().withNano(0);
    final Share.Row r = store.listOf(schemeId).stream()
        .filter((x) -> x.id() == shareId).findFirst()
        .orElseThrow(() -> ApiProblem.notFound(
            "这条分享口令不存在(或不属于这个方案):id=" + shareId));
    if (r.revoked()) {
      final Map<String, Object> m = one(r, now, null);
      m.put("changed", false);
      m.put("how", "本来就是撤销状态 -- 不需要再撤一次");
      return m;
    }
    store.revoke(schemeId, shareId);
    final Map<String, Object> detail = new LinkedHashMap<>();
    detail.put("shareId", shareId);
    // 口令**只留后 4 位**:audit_log 是用来"事后说得清"的,不是第二个口令仓库 --
    // 把完整口令抄进日志,等于多了一处泄露点,而且它比日志长得多。
    detail.put("tokenTail", tail(r.token()));
    detail.put("expiresAt", r.expiresAt() == null ? null : Share.fmt(r.expiresAt()));
    if (note != null && !note.isBlank()) {
      detail.put("why", note.trim());
    }
    audit.write(actorName(), ACTION_REVOKE, TARGET_SCHEME, String.valueOf(schemeId), json(detail));
    final Map<String, Object> m = one(store.listOf(schemeId).stream()
        .filter((x) -> x.id() == shareId).findFirst().orElse(r), now, note);
    m.put("changed", true);
    m.put("how", "已撤销:这条链接立刻打不开了");
    return m;
  }

  // ────────────────── 4 免登录读(凭据就是口令本身) ──────────────────

  /**
   * 凭口令读方案(**这是唯一不带角色门的接口** -- 打开它的人根本还没"身份")。
   *
   * 所以这里格外小心两件事:
   *   1 三种"不能用"给**三种不同的话**(过期 / 被撤销 / 不存在)-- 见 {@link Share#whyText};
   *   2 返回的东西**只包含"看方案"需要的**:不带方案 id、不带 owner、不带 `updatedBy`、
   *      不带封面的文件路径。口令持有人能看内容,但**不该顺手拿到调别的接口要用到的 id**。
   */
  public Map<String, Object> resolve(String token) {
    if (!Share.looksLikeToken(token)) {
      // 不解释"为什么不对":那是我们的规则,说细了就是在教人试口令
      throw ApiProblem.notFound("这个分享口令对不上。链接可能被抄错或被截断了 -- 找分享人要一条完整的。");
    }
    final Share.Row r = store.findByToken(token)
        .orElseThrow(() -> ApiProblem.notFound("这个分享口令不存在(可能已经被删了)"));
    final LocalDateTime now = LocalDateTime.now().withNano(0);
    final Share.State st = Share.stateOf(r, now);
    if (st != Share.State.VALID) {
      // 410:东西存在过、现在没了。用 404 也"不算错",但这两种情况的下一步动作不同 --
      // 404 让人怀疑自己抄错了,410 让人去问分享人。界面按 reason 分流(share-expired / share-revoked)。
      throw ApiProblem.gone(Share.codeOf(st),
          "这条分享链接" + Share.whyText(st, r.expiresAt()) + " -- 找分享人要一条新的。");
    }
    final SchemeStore.SchemeRow row = requireSharedScheme(r.schemeId(), r.createdBy());

    final Map<String, Object> meta = new LinkedHashMap<>();
    meta.put("rev", row.rev());
    meta.put("paramsRev", row.paramsRev());
    meta.put("status", row.status() == null ? "" : row.status());
    meta.put("updatedAt", row.updatedAt() == null ? null : row.updatedAt().toString());

    final Map<String, Object> share = new LinkedHashMap<>();
    share.put("by", sharerName(r.createdBy()));
    share.put("at", Share.fmt(r.createdAt()));
    share.put("expiresText", Share.expiryText(r.expiresAt()));

    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("readOnly", true);
    out.put("name", row.name());
    out.put("format", row.format());
    out.put("state", row.state());
    out.put("meta", meta);
    out.put("share", share);
    // 落库那一刻的结论。**null 有话说**:界面要写"这一份存得比「记结论」早",
    // 不许拿现在的结论冒充(与 B4d 同一条纪律)。
    // ⚠️ 名字与方案接口对齐(B9):`hasAudit` = 存过没有,`auditSaved` = 那一条结论。
    //    以前这里叫 `auditStored`(布尔)+ `audit`(对象),而方案列表里 `audit` 是**现算**的、
    //    `auditStored` 是对象 -- 同一对词两种意思,接前端必错。
    out.put("hasAudit", row.auditJson() != null);
    out.put("auditSaved", row.auditJson() == null ? null : parse(row.auditJson()));
    // 「你看到的是当前内容」这句话必须由**数据**带着走,不能只写在界面的静态文案里
    // ⚠️ 这句话会**原样出现在客户界面上**（面客模式的第二句）—— 中文标点要跟界面同一套，
    //    半角逗号在一句中文里很显眼（`docs/57` 记着这次修改）。
    out.put("seesCurrent", "原方案以后再改，这条链接看到的就是改后的样子");
    return out;
  }

  // ─────────────────────────── 内部小工具 ───────────────────────────

  /** 一条口令的**对外形状**(列表与生成共用一份,保证两处说的是一回事) */
  private Map<String, Object> one(Share.Row r, LocalDateTime now, String note) {
    final Share.State st = Share.stateOf(r, now);
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("id", r.id());
    m.put("token", r.token());
    m.put("path", Share.linkPath(r.token()));
    m.put("ok", st == Share.State.VALID);
    m.put("state", Share.codeOf(st));
    m.put("stateText", Share.whyText(st, r.expiresAt()));
    m.put("expiresText", Share.expiryText(r.expiresAt()));
    m.put("createdAt", Share.fmt(r.createdAt()));
    m.put("createdBy", r.createdBy());
    // 「还有几天」由界面算(它知道"现在"是几点;服务端算出来的那一刻就已经旧了)
    m.put("expiresAt", r.expiresAt() == null ? null : r.expiresAt().toString());
    if (note != null && !note.isBlank()) {
      m.put("note", note.trim());
    }
    return m;
  }

  private String tail(String token) {
    return token == null || token.length() < 4 ? "****" : "****" + token.substring(token.length() - 4);
  }

  /** 留痕里的"谁"：当前登录账号的登录名（登录名限 32 位以内，`audit_log.actor` 装得下） */
  private String actorName() {
    return user.username();
  }

  /**
   * 免登录页上的"谁分享的"：按口令那一行记的分享人查账号目录。
   *
   * 查不到（账号被物理删除、或内存档没有账号目录）时写 `#<id>` —— 原始 id 是事实，
   * 编一个名字就不是了。
   */
  private String sharerName(long createdBy) {
    final String name = admin.userNames().get(String.valueOf(createdBy));
    return name == null || name.isBlank() ? "#" + createdBy : name;
  }

  private static String json(Object o) {
    try {
      return JSON.writeValueAsString(o);
    } catch (Exception e) {
      throw new IllegalStateException("留痕内容转 JSON 失败:" + e.getMessage(), e);
    }
  }

  private static Object parse(String s) {
    try {
      return JSON.readValue(s, Map.class);
    } catch (Exception e) {
      // 读不动就**如实说读不动**:拿一句"读取失败"顶上去,比编一个空的结论强
      return Map.of("broken", true);
    }
  }
}