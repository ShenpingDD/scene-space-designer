package com.scene.spatial.scheme;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scene.spatial.api.ApiProblem;
import com.scene.spatial.audit.AuditService;
import com.scene.spatial.catalog.CatalogSource;
import com.scene.spatial.kernel.Json;
import com.scene.spatial.params.ParamsSource;
import com.scene.spatial.kernel.Scheme;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * SchemeService —— 方案的业务动作（接口层只做 HTTP 翻译）
 *
 * 三条规矩：
 *
 * ① **服务端是唯一裁判**：写之前一定过内核的 `Scheme.importScheme`，而且存的是**规范化后的 state**
 *    —— 内核会补齐缺省字段、丢掉不认识的字段，存"能导得回来"的那一份，导出/导入才逐字节稳定。
 *    FIX-05 的教训（自己导出的文件自己导不回来）不能在服务端重犯一遍。
 *
 * ② **乐观锁由存储层判定**（见 {@link SchemeStore}），本层只负责把冲突翻译成 409 并带上当前 rev。
 *    先查后写不算锁：中间有窗口，两个请求都能过检查，然后一个覆盖另一个。
 *
 * ③ **不在写路径上顺手算体检**：写路径要快、要稳，也不该为一个**用不到的结果**付代价。
 *    （这里原本写的是"规则 7 在 100 台时要 140 ms" —— 实测 Java 侧只有 19.6 ms，140 ms 是浏览器的数。
 *      规矩仍然成立，但**理由从"太慢"改成"职责单一"**。见 设计决策记录修正记录）。
 *    体检是**查询路径**的事 —— R4-3 落地成 `POST /api/audit`（{@link AuditService}，带缓存）；
 *    列表里那份 `audit` 摘要也是查询路径顺手取的，同一个缓存兜着（见 AuditCache）。
 */
@Service
public class SchemeService {

  // 方案名的"不能为空 / 不超 128 字"由接口层 DTO 的 Bean Validation 承担（SchemeDtos.CreateRequest），
  // 这里不再手写一遍 —— 边界只挡一次，别在两处维护同一件事（见 设计决策记录）。

  /** 结论落库用的序列化。独立一份，不与 Web 层的 Jackson 配置共享（本类的口径只有"往返一致"） */
  private static final ObjectMapper AUDIT_JACKSON = new ObjectMapper();

  private final SchemeStore store;
  /**
   * 目录**必须走 `CatalogSource`**（库优先 / 目录变了自动重读），不能直接注入 `Catalog`。
   *
   * 直接注入 `Catalog` 拿到的是 `KernelConfig.caseCatalog()` —— 那是**用例表内嵌的夹具目录**。
   * 后果不是"少几款"，而是「目录里有的型号，界面能摆、服务端保存时报 `bad-item`」：
   * 公开仓的夹具只留了 4 款，于是带 3D 模型的那两款（`demo-blender` / `demo-ct-scanner`）根本存不进方案。
   * 2026-11-24 真机实测踩到（历史文档里记过同一类事故，见 docs/DEVELOPMENT.md「目录有两份」）。
   */
  private final CatalogSource catalogs;
  private final AuditService audit;

  /** 封面落盘目录（默认 `assets/covers`，与 `V9` 那条列注释"文件在 assets/covers/"对上） */
  private final Path coversDir;

  /** 写进库的相对路径前缀 —— 就用配置里的原样字符串，不在代码里另拼一个"应该是"的值 */
  private final String coversDirText;
  private final ParamsSource params;

  public SchemeService(SchemeStore store, CatalogSource catalogs, AuditService audit,
                       @Value("${spatial.covers.dir:assets/covers}") String coversDir,
                       ParamsSource params) {
    this.store = store;
    this.catalogs = catalogs;
    this.audit = audit;
    // 方案落库时记的 `params_rev` 取**生效值那一版**的指纹（R6-4 B4a 起）。
    // 之前用的是 `Params.fingerprint()` —— 那个的输入是**默认值**，后台改了参数它一动不动，
    // 于是「这份方案是按哪版参数摆的」这个问题的答案永远是同一串数字（等于没答）。
    this.params = params;
    this.coversDirText = coversDir;
    this.coversDir = Paths.get(coversDir).toAbsolutePath().normalize();
  }

  /**
   * 这份方案用到的型号码（去重，按首次出现顺序）。**型号在 item 的 p 字段里，不在 id 里**。
   *
   * 为什么服务端要算这一小串：列表接口不发 items，客户端就拿不到型号 ——
   * 而卡片要显示"用了几个型号"、筛选要能"含某型号"。两个选择：把 items 发出去
   * （列表会变重），或者只发这一串码。选了后者。
   *
   * ⚠️ 前端 `app/src/admin/schemes.js` 的 `modelCodesFromItems` 是同一算法：
   *    列表走这里、详情走前端那份。**两处必须一致**，各有一份单测钉着同一批字面量。
   */
  private static List<String> modelCodes(Map<String, Object> state) {
    final List<String> out = new ArrayList<>();
    final Object items = state == null ? null : state.get("items");
    if (!(items instanceof List<?> list)) {
      return out;
    }
    for (final Object o : list) {
      if (!(o instanceof Map<?, ?> item)) {
        continue;
      }
      final Object p = item.get("p");
      final String code = p == null ? "" : String.valueOf(p).trim();
      if (!code.isEmpty() && !out.contains(code)) {
        out.add(code);
      }
    }
    return out;
  }

  /** 某人的方案列表（设计端方案库：只给当前登录账号的） */
  public List<Map<String, Object>> list(long ownerId, boolean deleted) {
    final List<Map<String, Object>> out = new ArrayList<>();
    for (final SchemeStore.SchemeRow r : store.list(ownerId, deleted)) {
      out.add(row(r));
    }
    return out;
  }

  /**
   * 维护端方案库：**全部账号**的方案。
   *
   * 两个筛选放在服务层（`ownerId` 与 `q`）：方案量级在几百，与 设计决策记录 §6「v1 不做分页」同一条口径。
   * 归属显示名与"所属账号是否停用"不在这里补 —— 服务层不认"谁叫什么"，
   * 由接口层用 `AdminService` 的账号目录补上（同一件事一处出处）。
   */
  public List<Map<String, Object>> listAll(boolean deleted, Long ownerId, String q) {
    final String needle = q == null ? "" : q.trim().toLowerCase(Locale.ROOT);
    final List<Map<String, Object>> out = new ArrayList<>();
    for (final SchemeStore.SchemeRow r : store.listAll(deleted)) {
      if (ownerId != null && r.ownerId() != ownerId) continue;
      if (!needle.isEmpty() && !r.name().toLowerCase(Locale.ROOT).contains(needle)) continue;
      out.add(row(r));
    }
    return out;
  }

  /**
   * 一行 → 列表里的一条。
   *
   * 设计端方案库与维护端方案库**共用这一处**：两边的列各写一份的话，
   * 「维护端看得见的、设计端看不见」这种差别会悄悄长出来，而那是最难查的一类不一致。
   */
  private Map<String, Object> row(SchemeStore.SchemeRow r) {
    final Map<String, Object> row = new LinkedHashMap<>();
    row.put("id", r.id());
    row.put("name", r.name());
    // 归属账号的 id 一起发：设计端看到的恒等于当前账号（B7 的"只看自己的"就靠它对照），
    // 维护端要靠它把显示名与启用状态补上来，两边的行形状因此仍然只有一份
    row.put("ownerId", r.ownerId());
    // 列表只给房间摘要，不给整份 state：列表页不该拖几 MB 的 JSON
    row.put("room", Json.obj("w", r.state().get("w"), "d", r.state().get("d"), "h", r.state().get("h")));
    row.put("itemCount", itemCount(r.state()));
    // 型号码（去重）单发一小串 —— 卡片要显示"用了几个型号"、筛选要能"含某型号"，
    // 而列表**不发 items**（见上面那句"列表页不该拖几 MB 的 JSON"）。
    row.put("modelCodes", modelCodes(r.state()));
    // 列表顺手带一句体检摘要：**"哪个方案的门开不到底"是列表页最该回答的问题**，
    // 而它只能靠规则 7 算出来（Java 侧百台 19.6 ms、浏览器 ~140 ms，见 设计决策记录）——
    // 没有缓存就不该在这儿做（见 AuditCache）。
    // 库里存的就是规范化过的 state，所以这里不再过一遍导入校验，直接算。
    // 列表这一条是**按现在的参数**现算的（缓存键含参数指纹与目录版本，B4d 起是真的了）
    // ⚠️ 名字就叫 `auditNow`（**现算的**）。以前它叫 `audit`，而只读分享接口里的 `audit` 指的是
    //    「**落库的**结论对象」、`auditStored` 又指布尔 —— 同一对词在三个接口里三种意思，
    //    接前端必错（写 B9 探针时差点就接错了）。现在三个名字互不重叠：
    //      · `auditNow`   = 现算的摘要（列表专用，`{issues,trouble}`）
    //      · `auditSaved` = 落库那一刻的结论**对象**（可能 null）
    //      · `hasAudit`   = 存过没有（布尔，只读分享接口用）
    row.put("auditNow", audit.summary(r.state()));
    // 落库那一刻存下的结论（**可能没有** —— 老方案就是没有，界面要说"没存下当时的"，不许拿上面那条冒充）
    row.put("auditSaved", readAudit(r.auditJson()));
    // "这一版是按哪版参数摆的" —— 与 `auditSaved.paramsRev` 不是一回事：那是"判的时候用的哪一版"
    row.put("paramsRev", r.paramsRev());
    row.put("rev", r.rev());
    // R6-3：这几个列 V1__init.sql 里就有，但 SchemeStoreJdbc.COLS 从来没读过 —— 读出来就得吐出去，
    // 否则"列在库里、界面上没有"的毛病会从存储层原样搬到接口层
    row.put("coverFile", r.coverFile());
    row.put("coverSize", r.coverSize());
    // 指纹要发给前端（V9 建列时就写着它是"前端缓存键"）：文件名固定、封面会互相覆盖，
    // 没有这个值前端就只能靠"URL 没变"去猜，然后给用户看一张旧图
    row.put("coverChecksum", r.coverChecksum());
    row.put("status", r.status());
    row.put("tags", r.tags());
    row.put("updatedBy", r.updatedBy());
    // 软删旗标也一起发：让"这一行在回收站里"由数据自己说，
    // 而不是由界面"我现在在哪个标签页"去推断
    row.put("deleted", r.deleted());
    row.put("createdAt", r.createdAt().toString());
    row.put("updatedAt", r.updatedAt().toString());
    return row;
  }

  public Map<String, Object> get(long id, long ownerId) {
    final SchemeStore.SchemeRow r = store.find(id, ownerId)
        .orElseThrow(() -> ApiProblem.notFound("方案不存在（或已被删除）：id=" + id));
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("id", r.id());
    out.put("name", r.name());
    out.put("rev", r.rev());
    out.put("format", r.format());
    out.put("paramsRev", r.paramsRev());
    // 落库那一刻的结论（含当时的 paramsRev / catalogRev）；老方案是 null
    out.put("auditSaved", readAudit(r.auditJson()));
    out.put("state", r.state());
    out.put("coverFile", r.coverFile());
    out.put("coverSize", r.coverSize());
    out.put("coverChecksum", r.coverChecksum());
    out.put("status", r.status());
    out.put("tags", r.tags());
    out.put("updatedBy", r.updatedBy());
    out.put("createdAt", r.createdAt().toString());
    out.put("updatedAt", r.updatedAt().toString());
    return out;
  }

  /** 建一份方案。`ownerId` 是**登录账号的 id**：归属从会话来，不从"库里第一行用户"来 */
  public Map<String, Object> create(long ownerId, String name, Object state) {
    final Map<String, Object> canonical = canonicalState(state);
    // 落库前判一次，**结论与内容同一条 INSERT 写进去**：
    // 分两步写会出现"内容已经是新的、结论还是上一版"的中间态，而那个中间态看起来一切正常
    final AuditService.Verdict v = audit.judge(canonical);
    final SchemeStore.SchemeRow r = store.create(ownerId, name,
        canonical, Scheme.FORMAT, params.version(), auditJsonOf(v));
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("id", r.id());
    out.put("name", r.name());
    out.put("rev", r.rev());
    out.put("status", r.status());
    out.put("createdAt", r.createdAt().toString());
    return out;
  }

  /** 保存（乐观锁）。`rev` 缺失是**客户端写错了**（400），不是并发冲突（409）—— 两者别混 */
  public Map<String, Object> save(long id, long ownerId, Integer rev, String name, Object state,
      String note) {
    if (rev == null) {
      throw ApiProblem.badRequest("rev-required",
          "保存必须带 rev（乐观锁）：请带上你手里的版本号，服务端才能判断有没有覆盖别人的改动");
    }
    final Map<String, Object> canonical = canonicalState(state);
    final AuditService.Verdict v = audit.judge(canonical);
    final SchemeStore.SaveResult r = store.save(id, ownerId, rev,
        name, canonical, Scheme.FORMAT, params.version(), auditJsonOf(v), note);

    if (r.notFound()) throw ApiProblem.notFound("方案不存在（或已被删除）：id=" + id);
    if (!r.isOk()) {
      throw ApiProblem.revConflict(r.conflict().rev(),
          "方案已被改过（你手里是第 " + rev + " 版，服务端已是第 " + r.conflict().rev()
              + " 版）：请刷新到最新再改，或另存为新方案");
    }

    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("id", r.saved().id());
    out.put("rev", r.saved().rev());
    out.put("updatedAt", r.saved().updatedAt().toString());
    return out;
  }

  /**
   * 只改方案名（验收 第二轮：方案名内联编辑）。
   *
   * ## 它不是一次保存
   *
   * 没有 `rev` 参数、不做乐观锁判断、**不产生新版本**：改名不动 `room_json`，
   * 也不写 `scheme_revision`。名字是这一份方案的标签，不是内容 —— 版本号回答的是
   * 「图形改过几次」，把改名混进去之后历史里会多出一串"内容一样、只有标题不同"的版本，
   * 用户回滚时根本分不清差别（与 `setCover` / `setStatus` 同一条口径）。
   *
   * 所以也不判 409：没有"你手里的版本旧了"这回事（内容一个字都没动）。
   *
   * ## 不存在 / 别人的方案
   *
   * 与 {@link #save} 同口径：**都回 404「方案不存在（或已被删除）」**。
   * 别人的方案在这里就是不存在 —— 这条纪律由存储层一条带 `owner_id` 的条件更新兜住，
   * 服务层不需要先查一遍（先查后写会留下窗口，见 `SchemeStore` 类注释）。
   *
   * 名称的合法性（非空、≤128 字）由接口层的 Bean Validation 挡下（400），
   * 与新建方案那一条同款 —— 这里不再写第二份判断。
   */
  public Map<String, Object> rename(long id, long ownerId, String name) {
    final SchemeStore.SchemeRow r = store.rename(id, ownerId, name)
        .orElseThrow(() -> ApiProblem.notFound("方案不存在（或已被删除）：id=" + id));
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("id", r.id());
    out.put("name", r.name());
    // rev 原样带回去（**没有变**）：前端靠它确认"改名没有产生新版本"
    out.put("rev", r.rev());
    return out;
  }

  public void delete(long id, long ownerId) {
    if (!store.softDelete(id, ownerId)) {
      throw ApiProblem.notFound("方案不存在（或已被删除）：id=" + id);
    }
  }

  /**
   * 从回收站恢复。
   *
   * 影响 0 行有**两种**可能，必须分开说（与 {@link #save} 里 notFound/conflict 同一条纪律）：
   *   · 方案真不存在 → 404
   *   · 方案在、但**本来就没被删** → **400 `not-deleted`**，而且这句话不是错话：
   *     用户可能是双击了两下，或者列表没刷新。告诉他「不需要恢复」比一句「不存在」有用得多。
   */
  public Map<String, Object> restore(long id, long ownerId) {
    if (!store.restore(id, ownerId)) {
      if (store.findAny(id, ownerId).isEmpty()) {
        throw ApiProblem.notFound("方案不存在：id=" + id);
      }
      throw ApiProblem.badRequest("not-deleted",
          "第 " + id + " 号方案没有被删除，不需要恢复（它一直在方案库里）");
    }
    final SchemeStore.SchemeRow r = store.find(id, ownerId)
        .orElseThrow(() -> new IllegalStateException("刚恢复的方案读不回来：id=" + id));
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("id", r.id());
    out.put("name", r.name());
    out.put("rev", r.rev());
    // 写明「恢复不动 rev」：前端拿到之后就不该去猜版本号变没变
    out.put("deleted", false);
    out.put("updatedAt", r.updatedAt().toString());
    return out;
  }

  /**
   * 复制一份。
   *
   * 返回里带 `fromId` / `fromRev`：界面上要说清「它是从哪一份、哪一版拷来的」——
   * 只说「复制成功」的话，用户过两天就会怀疑自己是不是拷了另一个版本。
   */
  public Map<String, Object> duplicate(long id, long ownerId, String name) {
    // 先读源方案：不是为了校验（顺序由存储层定），而是为了把「拷的是第几版」写进回执
    final SchemeStore.SchemeRow src = store.find(id, ownerId).orElse(null);
    if (src == null) {
      throw ApiProblem.notFound("方案不存在（或已被删除）：id=" + id
          + " —— 回收站里的方案要先恢复才能复制");
    }
    final SchemeStore.SchemeRow copy = store.duplicate(id, ownerId, name);
    if (copy == null) {
      // 读取通过、复制失败：只可能是两次读写之间它被删了。**说清是哪种可能**，不要让用户猜
      throw ApiProblem.notFound("第 " + id + " 号方案刚刚被删掉了，没有复制成；请刷新列表再看");
    }
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("id", copy.id());
    out.put("name", copy.name());
    out.put("rev", copy.rev());
    out.put("status", copy.status());
    out.put("fromId", src.id());
    out.put("fromRev", src.rev());
    out.put("createdAt", copy.createdAt().toString());
    return out;
  }

  /**
   * 回滚到历史里的某一版（**用户拍板 A1：回滚前先自动存一版**）。
   *
   * 为什么在这儿做那几道「说清理由」的检查：回滚是**会改动别人看得见的东西**的动作，
   * 一个含混的失败（「操作失败」）会让人反复重试，而重试在并发场景下是会撞车的。
   * 每道检查各给一句他自己的话：没说回到哪一版 / 没带手里的版本 / 回到的那一版就是当前 /
   * 回的比当前还新 / 那一版没有快照。
   */
  public Map<String, Object> rollback(long id, long ownerId, Integer targetRev, Integer expectRev,
                                      String note) {
    if (targetRev == null) {
      throw ApiProblem.badRequest("target-rev-required", "回滚必须说清要回到哪一版（targetRev）");
    }
    if (expectRev == null) {
      throw ApiProblem.badRequest("expect-rev-required",
          "回滚必须带上你手里的版本号（expectRev）：服务端才能判断会不会覆盖别人的改动");
    }
    if (targetRev < 1) {
      throw ApiProblem.badRequest("bad-rev", "版本号从 1 起（0 留给「从未保存过的草稿」），没有第 "
          + targetRev + " 版");
    }
    if (targetRev.equals(expectRev)) {
      throw ApiProblem.badRequest("rev-same",
          "第 " + targetRev + " 版就是当前版本，没有需要回滚的东西");
    }
    if (targetRev > expectRev) {
      // 回滚只能往回。真出现这种情况说明前端手里的版本号不新鲜 —— 说清而不是默默照做
      throw ApiProblem.badRequest("rev-ahead",
          "要回到的第 " + targetRev + " 版比当前的第 " + expectRev + " 版还新：回滚只能往回，请刷新列表");
    }

    // 判的是**要恢复成的那份内容**（不是当前内容）—— 恢复完这一版的结论说的就是它。
    // 拿不到那一版的快照时不做判断（null），让存储层照旧给出"没有快照"那句原话
    final SchemeStore.RevisionRow target = store.revision(id, ownerId, targetRev).orElse(null);
    final String auditJson = target == null ? null : auditJsonOf(audit.judge(target.state()));
    final SchemeStore.RollbackResult r = store.rollback(id, ownerId, expectRev, targetRev, auditJson, note);
    if (r.notFound()) throw ApiProblem.notFound("方案不存在（或已被删除）：id=" + id);
    if (r.targetMissing()) {
      // 这一版没有留痕快照 —— 回滚拿不到原料。
      // ⚠️ 别把它写成"老方案的历史是缺的"：**实测当前 5 条方案的逐版快照都是完整的**
      //    （2026-09-29：rev 2/2/1/1/1 ↔ 留痕 2+2+1+1+1=7）。真正成立的是"没有东西保证它完整"
      //    —— `scheme_revision` 上没有任何约束拦着"只写主表不写留痕"。
      //    所以这句话现在不会是常态，但它是**查得出来**的那种失败（哪几版能回滚，列表里看得见）。
      throw ApiProblem.badRequest("rev-not-found",
          "第 " + targetRev + " 版没有留存内容快照，回滚不了（老方案的历史只有部分版本）。"
              + "版本历史里能回滚的那几版才带内容摘要");
    }
    if (!r.isOk()) {
      throw ApiProblem.revConflict(r.conflict().rev(),
          "方案已被改过（你手里是第 " + expectRev + " 版，服务端已是第 " + r.conflict().rev()
              + " 版）：请刷新列表再回滚，否则会覆盖别人的改动");
    }

    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("id", r.applied().id());
    out.put("rev", r.applied().rev());
    out.put("rolledBackTo", targetRev);
    // 把 A1 那一句的**结果**如实回给界面：回滚前那一版是本来就留着，还是这次补存的
    out.put("keptRev", expectRev);
    out.put("keptWasExisting", r.keptWasExisting());
    out.put("updatedAt", r.applied().updatedAt().toString());
    return out;
  }

  /**
   * 收一张封面（R6-3 3f）。**封面是浏览器截的那张三维视角**，不是上传的文件。
   *
   * ## 顺序：先校验 → 再落盘 → 最后写库（三步都不许换位置）
   *
   * ① **校验在最前**：不合规就**不产生任何副作用** —— 尤其不许动 `updated_at`
   *    （否则库里会记下一次"某人改了方案"，而实际上什么都没存下来）。
   *
   * ② **先盘后库**：盘与库谁先谁后是有代价的，两边都试过才选了这一个 ——
   *    ＊ 先盘后库：库写失败 → 库里还是旧图（或没有），卡片显示旧图/占位。**文件总是存在的**。
   *    ＊ 先库后盘：库写成功而盘写失败 → 库里声称有封面、下发却 404 → **卡片是个破图**。
   *    两害相权取前者：「显示得旧一点」比「显示不出来」轻。
   *
   * ③ **封面不产生新版本**（不动 `rev`）：用户拍板"封面不跟版本走" ——
   *    一次方案一张图，新的覆盖旧的。**代价是 URL 不变**，所以 `coverChecksum`
   *    必须跟着内容变（它同时是下发接口的 ETag，也是前端的 `?v=`）。
   *
   * @return 回给界面的三样值，**取自库里的行**（不是我们以为写了什么）
   */
  public Map<String, Object> saveCover(long id, long ownerId, String actor, String dataUrl) {
    // ⚠️ 校验器抛的是裸 `IllegalArgumentException`（它不认识 HTTP，这样才对）；
    //    但**这一层必须把它翻成 4xx** —— 不翻的话它会落进 ApiAdvice 最下面的兜底变 500，
    //    把"客户端发的东西不合规"记成"服务端出了缺陷"。这个坑在 `ApiAdvice` 的注释里
    //    已经被记过两次，写这段时又踩了第三次（实测：非法 dataUrl 回的是 500 `internal`）。
    //    照 `ProductAdminController.upload` 的先例翻 —— 那边也是这么翻 Uploads.checkGlbName 的。
    final CoverImage.Decoded d;
    try {
      d = CoverImage.decode(dataUrl);
    } catch (IllegalArgumentException e) {
      throw ApiProblem.badRequest("bad-cover", e.getMessage());
    }
    // 方案必须存在且**在方案库里**（回收站里的不接新封面 —— 与 SQL 里的 deleted = 0 是同一句话）
    store.find(id, ownerId).orElseThrow(
        () -> ApiProblem.notFound("方案不存在（或已被删除）：id=" + id));

    try {
      CoverImage.store(coversDir, id, d.bytes());
    } catch (IOException e) {
      // 写盘失败是**服务端**的问题（500），不该伪装成客户端的错
      throw new IllegalStateException("封面落盘失败：" + coversDir + "（" + e.getMessage() + "）", e);
    }

    final String rel = coversDirText + "/" + id + ".png";
    final boolean written = store.setCover(id, ownerId, rel, d.bytes().length, d.md5(), actor);
    if (!written) {
      // 走到这里说明"校验通过之后、写库之前"这行发生了变化（被删了？）。
      // 不假装成功：文件已经落盘了，但库没接受 —— 如实报冲突。
      throw ApiProblem.notFound("方案在写入封面时已不在方案库里（可能刚被删除）：id=" + id);
    }

    // **重新读一遍**：回给界面的是库里的值。否则"界面显示 320 KB、库里是 0"这种错，查起来很费劲
    final SchemeStore.SchemeRow r = store.find(id, ownerId)
        .orElseThrow(() -> ApiProblem.notFound("方案不存在（或已被删除）：id=" + id));
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("id", id);
    out.put("coverFile", r.coverFile());
    out.put("coverSize", r.coverSize());
    out.put("coverChecksum", r.coverChecksum());
    out.put("updatedAt", r.updatedAt().toString());
    return out;
  }

  /**
   * 读一张封面（下发用）。
   *
   * `md5` 取自**库里那一列**（不是现算一遍）：本接口是唯一的写入方，
   * 所以库里的指纹就是当前文件内容的指纹，而它同时是客户端要用的 ETag。
   *
   * 库里说"有封面"、盘上却没有 → 回 404 并**说清是哪一半缺了**。
   * 这是服务端自己的不一致，但对浏览器（`<img>`）来说它就是"资源不在"，
   * 回 404 是对的；而**日志/消息里必须留下指纹**，否则只能看到一句"没找到"。
   */
  public CoverImage.Cover readCover(long id, long ownerId) {
    final SchemeStore.SchemeRow r = store.find(id, ownerId)
        .orElseThrow(() -> ApiProblem.notFound("方案不存在（或已被删除）：id=" + id));
    if (r.coverChecksum().isEmpty()) {
      throw ApiProblem.notFound("这份方案没有封面：id=" + id);
    }
    final Path f = CoverImage.fileOf(coversDir, id);
    try {
      return new CoverImage.Cover(Files.readAllBytes(f), r.coverChecksum());
    } catch (IOException e) {
      throw ApiProblem.notFound("封面文件不在了：" + f + "（库里记着的指纹是 " + r.coverChecksum() + "）");
    }
  }

  /**
   * 版本历史。**每一版带摘要**（几米 × 几米 / 几台 / 哪几个型号），但**不发全文**。
   *
   * 为什么要摘要：回滚是用户必须做的**一个选择**，而「第 3 版 / 第 4 版」这两行
   * 在他眼里长得一模一样 —— 让人在认不出的选项里选，等于让他掷骰子。
   *
   * 为什么不发全文：一版快照可能几百 KB（与 `list` 不发 `state` 同一条理由）。
   * 而每行都带 `isCurrent`：界面据此把「回滚」按钮对当前版本关上（回到当前版是没有意义的选择）。
   * 「历史是不是完整的」由 `rev` 序列自己说 —— 缺哪一版就是不列哪一版，不补。
   */
  public List<Map<String, Object>> revisions(long id, long ownerId) {
    final SchemeStore.SchemeRow row = store.find(id, ownerId)
        .orElseThrow(() -> ApiProblem.notFound("方案不存在（或已被删除）：id=" + id));
    final List<Map<String, Object>> out = new ArrayList<>();
    for (final SchemeStore.RevisionRow r : store.revisions(id, ownerId)) {
      final Map<String, Object> item = new LinkedHashMap<>();
      item.put("rev", r.rev());
      item.put("note", r.note());
      item.put("createdAt", r.createdAt().toString());
      item.put("paramsRev", r.paramsRev());
      // 这一版**被创建时**的结论（留档：不随后来的参数改动而变化；老版本是 null）
      item.put("auditSaved", readAudit(r.auditJson()));
      // 摘要用的是**这一版的快照**（不是当前版本）——两实现都保证它跟着版本走
      item.put("room", Json.obj("w", r.state().get("w"), "d", r.state().get("d"),
          "h", r.state().get("h")));
      item.put("itemCount", itemCount(r.state()));
      item.put("modelCodes", modelCodes(r.state()));
      item.put("isCurrent", r.rev() == row.rev());
      out.add(item);
    }
    return out;
  }

  // ── 结论落库（R6-4 B4d）────────────────────────────────────────────

  /**
   * 把一条结论装成要落库的 JSON。
   *
   * 形状：`{"report": {...}, "paramsRev": N, "catalogRev": M, "at": "..."}`
   * —— **两个版本号必须在里面**。少了它们，"按现参数复核"就没有左边可比
   * （只剩一句"当时判过"，那和没存一样）。
   */
  private static String auditJsonOf(AuditService.Verdict v) {
    try {
      return AUDIT_JACKSON.writeValueAsString(Json.obj(
          "report", v.report(),
          "paramsRev", v.paramsRev(),
          "catalogRev", v.catalogRev(),
          "at", java.time.LocalDateTime.now().toString()));
    } catch (Exception e) {
      // 序列化失败 = 代码缺陷（不是数据问题）→ 大声抛。**别吞**：吞下去的后果是"结论没存"，
      // 而"没存"在界面上长得和"还没做过"一模一样（本项目最怕的那种安静）
      throw new IllegalStateException("结论无法序列化（这是代码缺陷，不是数据问题）", e);
    }
  }

  /** 读回一条结论。`null`/空 → `null`（**老方案就是没有**，界面必须说"没存下当时那条"） */
  private static Map<String, Object> readAudit(String auditJson) {
    if (auditJson == null || auditJson.isBlank()) return null;
    try {
      return AUDIT_JACKSON.readValue(auditJson, new TypeReference<LinkedHashMap<String, Object>>() {
      });
    } catch (Exception e) {
      // 存了却读不回来 = 数据损坏（与 room_json 同一条规矩：数据损坏不是规则失败，要响）
      throw new IllegalStateException("scheme.audit_json 无法解析（这一列是我们自己写的）", e);
    }
  }

  /** 两个结论是不是同一件事：先看是不是同一份输入（参数 + 目录），再看几个数一不一样 */
  private static String compareVerdicts(Map<String, Object> stored, AuditService.Verdict now) {
    if (stored == null) return "unknown";
    final boolean sameInputs = eqNum(stored.get("paramsRev"), now.paramsRev())
        && eqNum(stored.get("catalogRev"), now.catalogRev());
    if (sameInputs) return "same-inputs";
    final Map<String, Object> a = subMap(stored.get("report"));
    final Map<String, Object> b = now.report();
    for (final String k : List.of("items", "issues", "trouble", "clean")) {
      if (!String.valueOf(a.get(k)).equals(String.valueOf(b.get(k)))) return "changed";
    }
    return "same-verdict";
  }

  private static boolean eqNum(Object a, long b) {
    return a instanceof Number n && n.longValue() == b;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> subMap(Object o) {
    return o instanceof Map ? (Map<String, Object>) o : Map.of();
  }

  /**
   * 按**现在的**参数复核一份已存方案（R6-4 B4d，只读）。
   *
   * 为什么不"把参数临时换成老那版、算完再换回来"：那会让并发请求在窗口里读到别人的参数，
   * 算出不属于任何一版的结论（见 `ParamsLive` 的类注释）。所以左边用**落库时存下的那条**，
   * 右边用现参数重判 —— 两边都是真的，谁也不冒充谁。
   */
  public Map<String, Object> recheck(long id, long ownerId) {
    final SchemeStore.SchemeRow r = store.find(id, ownerId)
        .orElseThrow(() -> ApiProblem.notFound("方案不存在（或已被删除）：id=" + id
            + " —— 回收站里的方案要先恢复才能复核"));
    final AuditService.Verdict now = audit.judge(r.state());
    final Map<String, Object> stored = readAudit(r.auditJson());

    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("id", r.id());
    out.put("rev", r.rev());
    out.put("name", r.name());
    // 内容是按哪版参数摆的（`scheme.params_rev`）—— 与结论里那个 rev 是两件事，
    // 界面上要写两句（参数改过之后它们会不一样，而那正是要给人看的）
    out.put("contentParamsRev", r.paramsRev());
    out.put("stored", stored);
    out.put("now", Json.obj("report", now.report(), "paramsRev", now.paramsRev(),
        "catalogRev", now.catalogRev()));
    out.put("compare", compareVerdicts(stored, now));
    out.put("cached", now.cached());
    out.put("costMs", now.costMs());
    return out;
  }

  // ── 内部 ────────────────────────────────────────────────────────────

  /**
   * 过一遍内核校验，返回**规范化后的 state**。
   *
   * 校验失败时抛 400，`reason` 直接用**内核的原因码**（`bad-room` / `bad-item` / `duplicate-id` …），
   * 界面按码给不同话术 —— 这正是 FIX-21 要的效果：别让 6 类失败共用一句话。
   */
  private Map<String, Object> canonicalState(Object state) {
    // 与体检共用同一处规范化（Canon）：两处各写一遍会让"体检的缓存键"和"存进去的东西"对不上，
    // 而"缓存看起来在工作、其实永远命中不了"是最难查的那种问题（设计决策记录判据⑤）
    return Canon.of(state, catalogs.current()).state();
  }


  private static int itemCount(Map<String, Object> state) {
    final Object items = state.get("items");
    return items instanceof List ? ((List<?>) items).size() : 0;
  }
}