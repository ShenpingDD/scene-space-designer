package com.scene.spatial.params;

import com.scene.spatial.api.ApiProblem;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * ParamsService —— 参数配置的读写编排（**校验 → 写 → 审计 → 提交后刷新**）
 *
 * 读（`view()`）与写（`publish()`）分得很开，因为门的形状不一样：
 * **读不设门**（前台设计器也要这份值，它又不是维护端），**写必过维护端角色门**。
 * 前端"把入口藏起来"不算门 —— 门在控制器里（见 `ParamsController`）。
 */
@Service
public class ParamsService {

  private final ParamsSchema schema;
  private final ParamsSource source;
  private final ObjectProvider<ParamsStore> stores;

  public ParamsService(ParamsSchema schema, ParamsSource source, ObjectProvider<ParamsStore> stores) {
    this.schema = schema;
    this.source = source;
    this.stores = stores;
  }

  /**
   * 界面要的一切：**规格 + 当前生效值 + 版本 + 来源 + 被拒绝的库值 + 上次发布时间**。
   *
   * 一次性给全，是为了让界面**不用自己拼**四个接口，也为了"缺数据不补"：
   * `origin` 说清这份值是从哪来的，`ignored` 说清有哪些库里的值没被采用（不许静默丢掉）。
   */
  /** 参数版本（指纹）。**只问版本的口用它** —— 前台轮询不该顺带把 46 项规格拉回去 */
  public int rev() {
    return source.version();
  }

  /** 与出厂默认值不一样的项数（0 = 后台没改过） */
  public int changedCount() {
    return source.changedCount();
  }

  /**
   * 参数审计查询（R6-4 B4c）：**谁、什么时候、把哪一项从多少改成多少、为什么**。
   *
   * 三条纪律：
   *   ① **`total` 与 `rows` 一起给** —— 界面常驻「显示 N / 共 M 条」，少了 M 就是静默筛选；
   *   ② 列表**不带全量快照**（一行就是 46 项），详情才给（{@link #auditOne}）；
   *   ③ 时间读不懂就 **400**，**绝不忽略**（"填了时间却全量返回"是最坏的一种静默）。
   *
   * 时间只用日期（`2026-09-29`）时：`from` 取当天 0 点、`to` 取当天 **23:59:59**
   * —— 否则"到 9-29"会把 9-29 一整天都排除掉（经典错法），而界面的条件句会写明「含当天」。
   */
  public Map<String, Object> audit(String from, String to, String path, String by, int limit, int offset) {
    final ParamsStore.AuditQuery q = new ParamsStore.AuditQuery(
        fromTime(from, false), fromTime(to, true), blank(path), blank(by), limit, offset);
    final List<Map<String, Object>> rows = new ArrayList<>();
    for (final ParamsStore.AuditItem it : source.auditPage(q)) rows.add(auditRow(it));
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("total", source.countAudit(q));      // 满足条件的**一共**几条（不是这一页几条）
    out.put("returned", rows.size());
    out.put("rows", rows);
    return out;
  }

  /**
   * 按指纹取那一版参数的值（R6-4 B4d）。三种情况要说清楚，**不许拿现状冒充**：
   *   · `default` —— 就是出厂值那一版（`ParamsFingerprint.defaults()`），库里本来就没有它的行；
   *   · `revision` —— 从 `config_revision` 的快照里取回来的（连带"是谁、什么时候改的"）；
   *   · `found:false` —— 取不回来（表被清理过 / 那一版不是本系统发布的），给一句原话。
   */
  public Map<String, Object> snapshot(int rev) {
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("rev", rev);
    if (rev == ParamsFingerprint.defaults()) {
      out.put("found", true);
      out.put("source", "default");
      // schema.defaults() 就是**扁平**那份（与 ParamsSource 装内核用的是同一个形状）
      out.put("values", schema.defaults());
      out.put("why", "这就是**出厂值**那一版 —— 库里从来不会有它自己的留痕行");
      return out;
    }
    final ParamsStore.AuditItem item = source.snapshotOf(rev);
    if (item == null) {
      out.put("found", false);
      out.put("source", null);
      out.put("why", "库里没有这一版参数的快照：要么它早于本系统开始记留痕，要么那一行已经被清理掉了"
          + " —— 取不回来就说取不回来，不拿现在的值冒充");
      return out;
    }
    out.put("found", true);
    out.put("source", "revision");
    out.put("values", item.snapshot());
    out.put("changedBy", item.changedBy());   // 显示名由控制器补（withNames，与 B4c 审计同一条路）
    out.put("changedAt", item.changedAt() == null ? null : item.changedAt().toString());
    out.put("note", item.note());
    out.put("why", "这一版是第 " + item.id() + " 条留痕记下来的（改完之后的整份值）");
    return out;
  }

  /** 单条（含全量快照）。**查不到不抛异常**：界面要能说"这条不在了"，而不是 500 或一片空白 */
  public Map<String, Object> auditOne(long id) {
    final ParamsStore.AuditItem it = source.auditOne(id);
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    if (it == null) {
      out.put("found", false);
      return out;                                 // 没有这一条：给一个"没有"，不给半个空壳
    }
    out.put("found", true);
    out.putAll(auditRow(it));
    out.put("snapshot", it.snapshot());
    return out;
  }

  private static Map<String, Object> auditRow(ParamsStore.AuditItem it) {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("id", it.id());
    m.put("key", it.path());
    m.put("rev", it.rev());
    m.put("oldValue", it.oldValue());
    m.put("newValue", it.newValue());
    m.put("changedBy", it.changedBy());
    m.put("changedAt", it.changedAt() == null ? null : it.changedAt().toString());
    m.put("note", it.note());
    return m;
  }

  /** 空串当"没填"（界面会把空输入框原样发上来） */
  private static String blank(String s) {
    return s == null || s.isBlank() ? null : s.trim();
  }

  /**
   * 解析查询时间。**读不懂就报错**（400），不静默：填了时间却拿到全量，用户会以为筛选生效了。
   * 认三种写法：`2026-09-29`、`2026-09-29 21:58`、`2026-09-29 21:58:14`（也认 ISO 的 `T`）。
   */
  private static LocalDateTime fromTime(String raw, boolean endOfDay) {
    final String s = blank(raw);
    if (s == null) return null;
    final String t = s.replace('T', ' ');
    try {
      if (t.length() == 10) {                                   // 只给了日期
        final LocalDate d = LocalDate.parse(t, DATE_ONLY);
        return endOfDay ? d.atTime(23, 59, 59) : d.atStartOfDay();
      }
      return LocalDateTime.parse(t, t.length() == 16 ? MINUTE : SECOND);
    } catch (Exception e) {
      // 用通用 400（不是 badParams：那个是某一项参数不合法，这里是筛选条件读不懂）
      throw ApiProblem.badRequest("bad-time",
          "审计查询的时间读不懂：「" + s + "」。要写成 2026-09-29 或 2026-09-29 21:58:14"
              + "（**没有忽略它** —— 静默忽略的话你会以为筛选生效了）");
    }
  }

  private static final DateTimeFormatter DATE_ONLY = DateTimeFormatter.ofPattern("yyyy-MM-dd");
  private static final DateTimeFormatter MINUTE = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");
  private static final DateTimeFormatter SECOND = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

  public Map<String, Object> view() {
    final Map<String, Object> out = new LinkedHashMap<>();
    final ParamsStore s = stores.getIfAvailable();
    out.put("ok", true);
    out.put("rev", source.version());
    out.put("origin", source.origin());
    out.put("changed", source.changedCount());   // 与出厂默认值不一样的项数（0 = 后台没改过）
    out.put("ignored", source.ignored());
    // 发**分组嵌套**那份：它要能直接喂给前端的 `configure()`（见 ParamsSource.grouped 的注释）
    out.put("values", source.grouped());
    out.put("schema", schema.raw());
    out.put("updatedAt", s == null ? null : s.lastChangedAt(ParamsStore.SCOPE_GLOBAL, ParamsStore.SCOPE_ID_NONE));
    return out;
  }

  /**
   * 发布一份参数补丁。
   *
   * ## 顺序是刻意的
   *
   * 1. **先整体校验**（用与 JS 侧同一套规则）：一处不合法就整份拒绝 —— 没有"改一半生效一半"。
   * 2. 算「改完之后」的整份值 → 指纹 = **新的参数版本号**（不是计数器，是散列）。
   * 3. 只写**真的变了**的项（每项 `app_config.rev` 加一），并各留一条 `config_revision`
   *    （`old_json` / `new_json` / **`snapshot_json` = 改完之后的全量** / note）。
   *    没变的项不写、也不留审计：发布一份一模一样的值**不该污染审计**。
   * 4. **事务提交之后**才刷新内存里的当前值。
   *
   * 第 4 条不是洁癖：如果提交前就刷新，而事务随后回滚了，内存里那份就是**假的** ——
   * 内核算规则会用一份库里并不存在的值，而界面上一切正常。刷新挂在 `afterCommit` 上，
   * 回滚时它根本不执行，所以内存只会跟着"真的落地了"的变化走。
   */
  @Transactional
  @SuppressWarnings("unchecked")   // patch 是嵌套 map（分组 → {键: 值}），取出内层时要转一次 —— 上面已用 schema 校验过形状
  public Map<String, Object> publish(Map<String, Object> patch, String note, Map<String, Object> me) {
    final ParamsStore store = stores.getIfAvailable();
    if (store == null) {
      // 没数据库就没得发布 —— 不装作可以（这一档生效的是参数表默认值）
      throw ApiProblem.badRequest("no-store",
          "这一档没有数据库（spatial.store=memory），参数发布不可用；现在生效的是参数表默认值");
    }
    final Map<String, Object> before = source.current();
    final List<Map<String, Object>> errors = schema.validate(patch, before);
    if (!errors.isEmpty()) {
      throw ApiProblem.badParams(errors, "参数不合法（" + errors.size() + " 处），一处都没写进去");
    }

    // 「改完之后」的整份值：审计快照与指纹都用它
    final Map<String, Object> after = new LinkedHashMap<>(before);
    final List<String> touched = new ArrayList<>();
    for (final Map.Entry<String, Object> g : patch.entrySet()) {
      for (final Map.Entry<String, Object> f : ((Map<String, Object>) g.getValue()).entrySet()) {
        final String path = g.getKey() + "." + f.getKey();
        after.put(path, f.getValue());
        touched.add(path);
      }
    }
    final int newRev = ParamsFingerprint.of(after);

    final List<String> changed = new ArrayList<>();
    for (final String path : touched) {
      final Object oldV = before.get(path);
      final Object newV = after.get(path);
      if (oldV != null && oldV.equals(newV)) continue;      // 没变就不写、不留审计
      changed.add(path);
      store.put(ParamsStore.SCOPE_GLOBAL, ParamsStore.SCOPE_ID_NONE, path, newV, valueTypeOf(newV),
          num(me.get("userId")));
      store.audit(new ParamsStore.AuditRow(path, ParamsStore.SCOPE_GLOBAL, ParamsStore.SCOPE_ID_NONE,
          newRev, oldV, newV, after, str(me.get("userId")), note == null ? "" : note));
    }

    final List<String> changedFinal = List.copyOf(changed);
    afterCommit(() -> source.reload());

    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("rev", newRev);
    out.put("changed", changedFinal);
    out.put("snapshotKeys", after.size());
    out.put("message", changedFinal.isEmpty()
        ? "没有任何改动 —— 一项都没写，也没留审计"
        : "已发布 " + changedFinal.size() + " 项，参数版本 " + newRev);
    return out;
  }

  /** 值类型（`app_config.value_type`）。参数表现在全是数字，但别把它写死成 'number' */
  private static String valueTypeOf(Object v) {
    if (v instanceof Boolean) return "boolean";
    if (v instanceof Number) return "number";
    return "string";
  }

  private static Long num(Object o) {
    return o instanceof Number ? ((Number) o).longValue() : null;
  }

  private static String str(Object o) {
    return o == null ? "" : String.valueOf(o);
  }

  /**
   * 把动作挂到**事务提交之后**。没有事务在跑（单测直接调）就立即执行 ——
   * 不能因为"没有事务"就永远不刷新（那会变成"发布完了值没变"）。
   */
  private static void afterCommit(Runnable action) {
    if (TransactionSynchronizationManager.isSynchronizationActive()) {
      TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
        @Override
        public void afterCommit() {
          action.run();
        }
      });
    } else {
      action.run();
    }
  }
}