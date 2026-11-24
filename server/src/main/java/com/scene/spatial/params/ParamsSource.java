package com.scene.spatial.params;

import com.scene.spatial.kernel.ParamsLive;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * ParamsSource —— 规则参数的**当前值**（唯一入口），照 `CatalogSource` 的样子
 *
 * 刷新策略一样：**最长 1 秒延迟的自动重读**（表只有 34 行，一次重读几毫秒）。
 * 比"每个请求都打库"省，比"改完要重启"诚实 —— 1 秒是"发布完刷新页面就看得见"的量级。
 *
 * ## 三层，别混
 *
 * ```
 * schema.defaults()   ← 编译期基线（= spatial-core/src/params.js 的 PARAM_SPEC）
 *      ↓ 被下面覆盖
 * app_config 的行     ← 后台改过的值（**真源**）
 *      ↓ 校验（未知项 / 不是数字 / 超范围 → 拒绝并说出来）
 * 生效值 current()    ← 内核算规则用的那一份；指纹由它算
 * ```
 *
 * ## 两条不能省的
 *
 * 1. **库里的值不合法 → 拒绝它，并且响亮**（`log.warn` + `ignored()` 列出来）。
 *    静默用默认值是最坏的："后台明明改了却没生效"和"改错了没人知道"会长得一模一样。
 * 2. **它同时是内核参数的**唯一写入者**（R6-4 B4d）：库 → 校验 → 生效值 → `ParamsLive.install()`。
 *    不装的话，`audit/AuditService` 与内核各算各的 —— 前端按后台改的值判、服务端按出厂值判，
 *    `docs/25 §6` 那句「两边必须一致」就成了空话（实测见 docs/40 §一）。
 * 3. **`version()` 只在值真的变了时才变**，它就是 {@link ParamsFingerprint}（不是计数器）。
 *    带它的地方：方案落库写 `params_rev`、体检缓存的键。不带它的后果是
 *    "后台一改参数，缓存还继续吐旧结论，而看起来一切正常" —— 最难查的那类。
 */
@Component
public class ParamsSource {

  private static final Logger log = LoggerFactory.getLogger(ParamsSource.class);

  /** 自动重读的最小间隔（毫秒）。这是节流，不是缓存正确性 */
  private static final long TTL_MS = 1000;

  private final ObjectProvider<ParamsStore> store;
  private final ParamsSchema schema;

  private volatile Map<String, Object> current;
  private volatile String origin;
  private volatile int version;
  private volatile List<String> ignored = List.of();
  /** 与**出厂默认值**不一样的项数。0 = 后台一次都没改过（界面要能这么直说） */
  private volatile int changedCount = 0;
  private volatile long readAt;
  /** 上一次读到的**原样行**；`null` = 还没读过（首次装载不算"变更"） */
  private volatile Map<String, Object> lastRaw;
  private volatile boolean hadDb;

  /** 无数据库档与单元测试用：只有参数表默认值 */
  public ParamsSource(ParamsSchema schema) {
    this(null, schema);
  }

  @Autowired
  public ParamsSource(ObjectProvider<ParamsStore> store, ParamsSchema schema) {
    this.store = store;
    this.schema = schema;
    rebuild();
  }

  /**
   * 当前生效值，**扁平**（`door.openOkDeg` → 90）。**所有算规则的地方都走这里**
   * —— 指纹也读它（指纹的输入本来就是 `path=值` 这种扁平形式）。
   */
  public Map<String, Object> current() {
    refreshIfStale();
    return current;
  }

  /**
   * 当前生效值，**分组嵌套**（`{door: {openOkDeg: 90}}`）。
   *
   * ⚠️ 为什么要有两个形状：接口发出去的那一份要能**直接喂给前端的 `configure()`**
   * （它收的就是分组嵌套）。第一版接口发的是扁平那份，前端拿到 34 个顶层键
   * —— `configure()` 第一句就会报「未知分组：door.openOkDeg」。两个形状是**两个消费者**，
   * 不是同一件事的两种写法：扁平那份服务于"按 path 查值"（规则 + 指纹），
   * 分组那份服务于"界面表单 / 内核 configure"。
   */
  public Map<String, Object> grouped() {
    refreshIfStale();
    final Map<String, Object> out = new LinkedHashMap<>();
    for (final Map.Entry<String, Object> e : current.entrySet()) {
      final int dot = e.getKey().indexOf('.');
      final String g = dot < 0 ? "" : e.getKey().substring(0, dot);
      final String k = dot < 0 ? e.getKey() : e.getKey().substring(dot + 1);
      @SuppressWarnings("unchecked")
      final Map<String, Object> bucket = (Map<String, Object>) out.computeIfAbsent(g, x -> new LinkedHashMap<>());
      bucket.put(k, e.getValue());
    }
    return out;
  }

  /** 参数版本 = 指纹。**它跟着值走，不跟着"改了几次"走** */
  public int version() {
    refreshIfStale();
    return version;
  }

  /** 这一份是从哪来的（数据库 / 参数表默认值）——"现在裁判用的是哪一份"要说得出来 */
  public String origin() {
    refreshIfStale();
    return origin;
  }

  /** 与出厂默认值不一样的项数（0 = 没改过） */
  public int changedCount() {
    refreshIfStale();
    return changedCount;
  }

  /** 库里有、但被拒绝的值（不合法或不在参数表里）——界面必须能看见，不许静默丢掉 */
  public List<String> ignored() {
    refreshIfStale();
    return ignored;
  }

  /** 强制重读（发布完参数立即调用；**要在事务提交之后**，见 ParamsService.publish 的注释） */
  public synchronized void reload() {
    rebuild();
  }

  /**
   * 审计查询（B4c）。**不走那份 1 秒 TTL 的缓存** —— 缓存是给"规则值"用的，
   * 而审计问的是"我刚改的那一条在不在"，必须现读（不然发布完刷新页面看不见自己那一条）。
   */
  public List<ParamsStore.AuditItem> auditPage(ParamsStore.AuditQuery q) {
    final ParamsStore s = store == null ? null : store.getIfAvailable();
    return s == null ? List.of() : s.auditPage(q);
  }

  /** 同上：数一共几条也要现读 */
  public int countAudit(ParamsStore.AuditQuery q) {
    final ParamsStore s = store == null ? null : store.getIfAvailable();
    return s == null ? 0 : s.countAudit(q);
  }

  /** 取一条（含全量快照）；没有 store 或 id 不存在 → null */
  public ParamsStore.AuditItem auditOne(long id) {
    final ParamsStore s = store == null ? null : store.getIfAvailable();
    return s == null ? null : s.auditOne(id);
  }

  /** 按指纹取那一版参数的快照（B4d）；没有 store 或没有那一版 → null（= 取不回来，界面照实说） */
  public ParamsStore.AuditItem snapshotOf(int rev) {
    final ParamsStore s = store == null ? null : store.getIfAvailable();
    return s == null ? null : s.snapshotOf(rev);
  }

  private void refreshIfStale() {
    if (System.currentTimeMillis() - readAt < TTL_MS) return;
    rebuild();
  }

  private synchronized void rebuild() {
    readAt = System.currentTimeMillis();
    final Map<String, Object> effective = new LinkedHashMap<>(schema.defaults());
    final List<String> bad = new ArrayList<>();

    final ParamsStore s = store == null ? null : store.getIfAvailable();
    final Map<String, Object> rows = s == null
        ? Map.of() : s.values(ParamsStore.SCOPE_GLOBAL, ParamsStore.SCOPE_ID_NONE);

    for (final Map.Entry<String, Object> e : rows.entrySet()) {
      final ParamsSchema.Entry spec = schema.entry(e.getKey());
      if (spec == null) {
        bad.add(e.getKey() + "：参数表里没有这一项（库里的孤行，不会被采用）");
        continue;
      }
      final Object v = e.getValue();
      if (!(v instanceof Number) || !Double.isFinite(((Number) v).doubleValue())) {
        bad.add(e.getKey() + "：库里存的是 " + v + "，不是数字（不会被采用）");
        continue;
      }
      final double d = ((Number) v).doubleValue();
      if (d < spec.min() || d > spec.max()) {
        bad.add(e.getKey() + "：" + ParamsFingerprint.canonicalValue(v) + " 超出 "
            + ParamsFingerprint.canonicalValue(spec.min()) + "~" + ParamsFingerprint.canonicalValue(spec.max())
            + spec.unit() + "（不会被采用）");
        continue;
      }
      effective.put(e.getKey(), v);
    }

    final int next = ParamsFingerprint.of(effective);
    final boolean first = lastRaw == null;
    final boolean changed = !first && !rows.equals(lastRaw);

    if (!bad.isEmpty()) {
      log.warn("[params] 库里有 {} 项没被采用（界面会显示出来，不静默）：{}", bad.size(), bad);
    }
    if (changed) {
      // 先打日志再赋值 —— 顺序写反了会把"旧指纹"打成新指纹（改了却看不出来改了什么）
      log.info("[params] 参数已变更：指纹 {} → {}（来源 {}）", version, next,
          rows.isEmpty() ? "参数表默认值" : "数据库");
    } else if (first) {
      log.info("[params] 参数装载：{} 项，指纹 {}，来源 {}", effective.size(), next, rows.isEmpty() ? "参数表默认值" : "数据库");
    }
    if (hadDb && rows.isEmpty()) {
      // 本来有库、现在读不到了：**这是变化，要响亮**（不能让规则悄悄换回默认值）
      log.warn("[params] 参数来源从数据库降级到参数表默认值（指纹 {}）", next);
    }

    // 把生效值装进内核（**顺序要紧**：先装值、后报版本 —— 反过来会出现
    // "版本说新的、内核还在用旧的"那一瞬间，而那正是"改了却没生效"最容易冒充的样子）
    final List<String> unknown = ParamsLive.install(effective, next, rows.isEmpty()
        ? "参数表默认值" : (bad.isEmpty() ? "数据库" : "数据库（有 " + bad.size() + " 项没被采用）"));
    if (!unknown.isEmpty()) {
      // 走到这里说明调用方递了一份不该有的键 —— 说出来，别静默（`effective` 由 schema.defaults() 起头，正常不会有）
      log.warn("[params] 装进内核的值里有 {} 个参数表外的键被忽略：{}", unknown.size(), unknown);
    }

    version = next;
    current = Map.copyOf(effective);
    ignored = List.copyOf(bad);
    // 「来源=数据库」单说是不准的：库里 34 行、全是出厂值时，说「数据库」会让人以为后台改过什么。
    // 所以把**改过几项**一起说 —— 「改过 0 项」和「改过 2 项」对用户是两件事。
    changedCount = (int) effective.entrySet().stream()
        .filter(e -> !ParamsFingerprint.canonicalValue(e.getValue())
            .equals(ParamsFingerprint.canonicalValue(schema.defaults().get(e.getKey()))))
        .count();
    origin = rows.isEmpty()
        ? "参数表默认值"
        : (changedCount == 0 ? "数据库（全是出厂值，没改过）" : "数据库（改过 " + changedCount + " 项）");
    lastRaw = rows;
    hadDb = !rows.isEmpty();
  }
}