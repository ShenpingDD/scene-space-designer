package com.scene.spatial.scheme;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.scene.spatial.api.ApiProblem;
import com.scene.spatial.audit.AuditService;
import com.scene.spatial.auth.CurrentUser;
import com.scene.spatial.catalog.CatalogSource;
import com.scene.spatial.catalog.DbCatalog;
import com.scene.spatial.kernel.Catalog;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.LinkedHashSet;

/**
 * DeliveryService —— 交付包（R6-5 / A10·A11·A13）
 *
 * 三件事都在这里：
 *   ① **打包**（`POST /api/schemes/{id}/delivery`）—— 生成的包 + 一条交付记录 + 「已交付」自动置位（A11）
 *   ② **交付历史**（读）—— 谁、什么时候、哪一版、哪些文件
 *   ③ **人工改回**（A11 后半句）—— 允许改回去，但**必须说清为什么**，并写进 `audit_log`
 *
 * ## 包必须钉在某一版上（所以要求 `expectRev`）
 *
 * 交付团队拿到的图纸，两个月后要能回答"这是第几版"。所以：
 *   · 请求必须带上**用户手里那一版**（`expectRev`），与库里的对不上就 409 —— 与保存同一把乐观锁；
 *   · 包里所有内容（方案.json / CSV / README / 体检报告）**全部取自库里那一行**，
 *     只有浏览器渲染的图形（平面图 / 三维截图）是"屏幕上那份"。
 *
 * 于是界面那边有一条硬要求（写在 `SchemePanel` 里）：**画布上有未保存的改动时不许打包** ——
 * 否则会出现"截图是新的、数据是旧的"这种包，而它**看不出来**（两张图与数据各自都自洽）。
 */
@Service
public class DeliveryService {

  /** `audit_log.target_type` 的取值（与 `docs/32` 的"某对象的历史"同口径） */
  private static final String TARGET_SCHEME = "scheme";

  /** 人工改状态的留痕动作名。**打包本身不写 `audit_log`** —— 交付记录已经是最详细的那一条 */
  private static final String ACTION_STATE = "scheme.delivery-state";

  private static final ObjectMapper JSON = new ObjectMapper();

  private final SchemeStore schemes;
  private final SchemeService schemeService;
  private final DeliveryStore store;
  private final CatalogSource catalogs;
  private final AuditService audit;
  /** 当前登录账号（归属、打包人名字快照都从这里取） */
  private final CurrentUser user;
  /** 目录的**界面形状**（型号 / 名称 / 占地 / 尺寸可信度）—— 只有落库档才有 */
  private final ObjectProvider<DbCatalog> dbCatalog;

  public DeliveryService(SchemeStore schemes, SchemeService schemeService, DeliveryStore store,
                         CatalogSource catalogs, AuditService audit,
                         CurrentUser user, ObjectProvider<DbCatalog> dbCatalog) {
    this.schemes = schemes;
    this.schemeService = schemeService;
    this.store = store;
    this.catalogs = catalogs;
    this.audit = audit;
    this.user = user;
    this.dbCatalog = dbCatalog;
  }

  /** 打包的结果：zip 字节 + 包文件名 + 逐件清单 + **这一次没带上的东西**（回给界面同一份） */
  public record Packaged(byte[] zip, String fileName, List<Map<String, Object>> files,
                         boolean withAssets, List<String> missing, long deliveryId,
                         int rev, int paramsRev) {
  }

  /**
   * 打一个交付包。
   *
   * 顺序是刻意的：**先把所有原料备齐并校验 → 再一次性落记录 + 置状态**。
   * 反过来（先落记录再备料）会出现"库里已交付、包却没生成"的状态 ——
   * 而那个状态**看起来是成功的**（列表上写着已交付），用户不会知道要重来一次。
   */
  @Transactional
  public Packaged pack(Long id, Integer expectRev, List<String> itemIds, boolean withAssets, String note,
                       String planSvg, List<String> shots, List<String> shotViews, Map<String, String> rooms) {
    final long ownerId = user.id();
    final SchemeStore.SchemeRow row = schemes.find(id, ownerId).orElseThrow(
        () -> ApiProblem.notFound("方案不存在（或已被删除）：id=" + id + " —— 回收站里的方案要先恢复再交付"));

    // ① 版本必须对得上（见类注释：包钉在某一版上）
    if (expectRev == null) {
      throw ApiProblem.badRequest("rev-required",
          "生成交付包必须带上你手里的版本号（expectRev）：包里会写清钉在第几版，"
              + "对不上就说明你屏幕上那份与库里那份不是同一版");
    }
    if (!expectRev.equals(row.rev())) {
      throw ApiProblem.revConflict(row.rev(), "方案已被改过（你手里是第 " + expectRev
          + " 版，服务端已是第 " + row.rev() + " 版）：请刷新到最新再打交付包 —— "
          + "否则包上写的版本号与实际内容对不上");
    }

    // ② 勾选名单（不认识的 id 当场说清是哪一串）
    final List<Delivery.Item> items = selectedOrBadRequest(itemIds);

    // ③ 备料（缺什么就说什么：不静默少一件）
    final Map<String, Map<String, Object>> byId = byRecipeId();
    final LocalDateTime now = LocalDateTime.now();
    final String at = now.toString();
    final String by = actorName();
    final List<String> missing = new ArrayList<>();
    final List<Delivery.Entry> body = new ArrayList<>();

    if (items.contains(item("json"))) {
      body.add(new Delivery.Entry("方案.json", Delivery.planJson(row.state(), row.format(), row.id(),
          row.name(), row.rev(), row.paramsRev(), catalogs.version(), at)));
    }
    if (items.contains(item("plan"))) {
      if (planSvg == null || !planSvg.contains("<svg")) {
        throw ApiProblem.badRequest("plan-required",
            "要带平面图就得把画好的 SVG 一起交上来（这次没收到合法的 SVG）—— "
                + "刷新页面重试；如果一直这样，说明浏览器那边有问题");
      }
      body.add(new Delivery.Entry("平面图.svg", planSvg.getBytes(StandardCharsets.UTF_8)));
    }
    if (items.contains(item("shots"))) {
      body.addAll(shotEntries(shots, shotViews));
    }
    if (items.contains(item("cover"))) {
      // 两种"没有封面"要分开说：**没截过**（正常）与**库里记着有、盘上不在**（服务端自己的不一致）
      if (row.coverChecksum() == null || row.coverChecksum().isBlank()) {
        missing.add("封面.png（这一份还没有封面 —— 在设计器里「重截并更新」一次就有了）");
      } else {
        try {
          body.add(new Delivery.Entry("封面.png", schemeService.readCover(row.id(), ownerId).bytes()));
        } catch (ApiProblem e) {
          missing.add("封面.png（库里记着有，但取不到：" + e.getMessage() + "）");
        }
      }
    }
    if (items.contains(item("csv"))) {
      // 房间名由客户端算好递进来（键 = 设备 id）—— 服务端只写那一列，不重算派生面（见 DTO 注释）
      body.add(new Delivery.Entry("设备清单.csv", Delivery.csv(row.state(), byId, rooms)));
    }
    if (items.contains(item("report"))) {
      final AuditService.Verdict v = audit.judge(row.state());
      body.add(new Delivery.Entry("体检报告.json", Delivery.reportJson(readStored(row), v.report(),
          row.paramsRev(), v.paramsRev(), v.catalogRev(), row.id(), row.rev())));
    }
    if (withAssets) {
      body.addAll(assetEntries(row.state(), byId, missing));
    }
    if (items.contains(item("readme"))) {
      // README 要写"包里有什么"，所以它只能在别的件都定下来之后生成 —— 并且**排在最前面**
      body.add(0, new Delivery.Entry("README.md", Delivery.readme(row.state(), byId, row.name(),
          row.id(), row.rev(), row.paramsRev(), catalogs.version(), catalogs.origin(), at, by,
          body, withAssets, missing, readStored(row))));
    }

    final byte[] zip = Delivery.zip(body);

    // ④ 落记录 + 置状态（同一个事务：记录与状态不许一个成一个不成）
    final List<Map<String, Object>> manifest = manifestOf(body);
    final DeliveryStore.DeliveryRow rec = store.record(row.id(), row.rev(), row.paramsRev(),
        catalogs.version(), jsonOf(manifest), withAssets, by, note == null ? "" : note);
    if (!schemes.setStatus(row.id(), ownerId, SchemeStore.STATUS_DELIVERED, by)) {
      throw ApiProblem.notFound("方案在写入交付记录时已不在方案库里（可能刚被删除）：id=" + id);
    }

    return new Packaged(zip, fileName(row.name(), row.rev(), now), manifest, withAssets, missing,
        rec.id(), row.rev(), row.paramsRev());
  }

  /**
   * 可勾选的件清单（**唯一出处**：界面不抄这张表）。
   *
   * 每一件带 `files`：它落成哪些文件名 —— 界面靠它核对"勾了的到底在不在包里"（
   * 少一件的包与齐的包长得一模一样，必须能算出来）。
   */
  public List<Map<String, Object>> itemRegistry() {
    final List<Map<String, Object>> out = new ArrayList<>();
    for (final Delivery.Item i : Delivery.ITEMS) {
      final Map<String, Object> m = new LinkedHashMap<>();
      m.put("id", i.id());
      m.put("label", i.label());
      m.put("why", i.why());
      m.put("fromBrowser", i.fromBrowser());
      m.put("required", i.required());
      m.put("files", Delivery.namesOf(i));
      out.add(m);
    }
    return out;
  }

  /** 三个固定视角的 id 与名字（A13）—— 与浏览器那份 `views3d.js` 的顺序**必须一字不差** */
  public List<Map<String, Object>> viewRegistry() {
    final List<Map<String, Object>> out = new ArrayList<>();
    for (final Delivery.View v : Delivery.VIEWS) {
      final Map<String, Object> m = new LinkedHashMap<>();
      m.put("id", v.id());
      m.put("label", v.label());
      m.put("how", v.how());
      m.put("file", v.name());
      out.add(m);
    }
    return out;
  }

  /** 交付历史（新的在前）。`files` 解析成数组发出去，界面上要显示"这一包里有哪几件" */
  public List<Map<String, Object>> deliveries(long id) {
    final long ownerId = user.id();
    schemes.find(id, ownerId).orElseThrow(
        () -> ApiProblem.notFound("方案不存在（或已被删除）：id=" + id));
    final List<Map<String, Object>> out = new ArrayList<>();
    for (final DeliveryStore.DeliveryRow r : store.list(id)) {
      final Map<String, Object> m = new LinkedHashMap<>();
      m.put("id", r.id());
      m.put("rev", r.rev());
      m.put("paramsRev", r.paramsRev());
      m.put("catalogRev", r.catalogRev());
      m.put("files", parseFiles(r.filesJson()));
      m.put("withAssets", r.withAssets());
      m.put("packagedBy", r.packagedBy());
      m.put("packagedAt", r.packagedAt().toString());
      m.put("note", r.note());
      out.add(m);
    }
    return out;
  }

  /**
   * 人工改交付状态（A11：允许人工改回并留痕）。
   *
   * **必须写原因**：这条记录是"图纸已经交出去了"的证据，改它就是**推翻一件已经发生过的事**。
   * 允许改（人总会发错、包总会打错），但改的人要为自己的话负责 —— 所以 `note` 必填，
   * 而且原话进 `audit_log.detail_json`（`audit_log` 一旦写入就不再被任何代码改或删）。
   *
   * 只认 `draft` / `delivered` 两个值：`submitted`（送审中）这一版还没有任何流程用它，
   * 让人手工填一个系统不认识的状态，等于在库里种一个没人解释得了的值。
   */
  @Transactional
  public Map<String, Object> setState(Long id, String status, String note) {
    final long ownerId = user.id();
    final SchemeStore.SchemeRow row = schemes.find(id, ownerId).orElseThrow(
        () -> ApiProblem.notFound("方案不存在（或已被删除）：id=" + id));
    if (!SchemeStore.STATUS_DRAFT.equals(status) && !SchemeStore.STATUS_DELIVERED.equals(status)) {
      throw ApiProblem.badRequest("bad-status", "交付状态只认 draft（未交付）/ delivered（已交付）"
          + "（收到的是：" + (status == null || status.isBlank() ? "(空)" : status) + "）");
    }
    if (note == null || note.isBlank()) {
      throw ApiProblem.badRequest("note-required",
          "改交付状态必须写一句为什么（这句话会进审计日志，改不了也删不掉）—— 例如"
              + "「包打错了，重打一版」「图改了，要重新交付」");
    }
    final String by = actorName();
    if (!schemes.setStatus(row.id(), ownerId, status, by)) {
      throw ApiProblem.notFound("方案在改状态时已不在方案库里（可能刚被删除）：id=" + id);
    }
    final Map<String, Object> detail = new LinkedHashMap<>();
    detail.put("from", row.status());
    detail.put("to", status);
    detail.put("note", note);
    detail.put("rev", row.rev());
    store.writeAudit(by, ACTION_STATE, TARGET_SCHEME, row.id(), jsonOf(detail));

    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("id", row.id());
    out.put("status", status);
    out.put("from", row.status());
    return out;
  }

  /** 某份方案的改状态留痕（界面把"谁在什么时候把已交付改回去了"显示出来） */
  public List<Map<String, Object>> stateHistory(long id) {
    return store.auditOf(TARGET_SCHEME, id);
  }

  /**
   * 型号使用情况（R6-5 验收判据③：「**从未被使用的型号**能在统计里查出来」）。
   *
   * 为什么值得做：目录里躺着的型号如果从来没人摆过，它就是在占位置 ——
   * 而"有没有人用"只有把方案翻一遍才知道（使用记录在 `scheme.room_json` 的 items 里）。
   * 统计**只读**，不改任何东西。
   */
  public Map<String, Object> usage() {
    final Map<String, List<String>> usedBy = new LinkedHashMap<>();   // 型号 → 用过它的方案
    final Map<String, String> lastAt = new LinkedHashMap<>();
    // 数**全部账号**的方案：多用户上线之后，只数某一个账号名下的方案会让
    // 「从未被使用的型号」这个判据变成一句假话（别人的方案里用过，统计却说没人用）
    // 只看方案库（回收站里的不算"用过" —— 它已经不在日常视野里了）
    for (final SchemeStore.SchemeRow r : schemes.listAll(false)) {
      for (final String code : Delivery.groupByModel(r.state()).keySet()) {
        usedBy.computeIfAbsent(code, k -> new ArrayList<>()).add(r.name() + " · #" + r.id());
        lastAt.put(code, r.updatedAt().toString());
      }
    }
    final Map<String, Map<String, Object>> catalog = byRecipeId();
    // 目录里有的（byRecipeId）+ 方案里用过但目录里没了的（下架型号）**都要列出来**：
    // 只列目录的话，"方案里摆着一个目录里没有的型号"这件事就永远查不出来
    final Set<String> ids = new LinkedHashSet<>(catalog.keySet());
    ids.addAll(usedBy.keySet());
    final List<Map<String, Object>> used = new ArrayList<>();
    final List<Map<String, Object>> never = new ArrayList<>();
    for (final String code : ids) {
      final Map<String, Object> p = catalog.get(code);
      final int uses = usedBy.getOrDefault(code, List.of()).size();
      final Map<String, Object> m = new LinkedHashMap<>();
      m.put("id", code);
      m.put("model", p == null ? code : p.get("model"));
      m.put("name", p == null ? "" : p.get("name"));
      m.put("inCatalog", p != null);
      m.put("uses", uses);
      m.put("usedBy", usedBy.getOrDefault(code, List.of()));
      m.put("lastUsedAt", lastAt.get(code));
      if (uses == 0) never.add(m);
      else used.add(m);
    }
    used.sort((a, b) -> Integer.compare((Integer) b.get("uses"), (Integer) a.get("uses")));
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("models", used);
    out.put("neverUsed", never);
    out.put("total", used.size() + never.size());
    // ⭐ 报**这张表实际用的那一份目录**，不是 `CatalogSource.origin()`：
    //    实测（2026-09-30）两者会不一致 —— `CatalogSource` 说的是**内核**目录（那份只带 id 与占地），
    //    而这里展示的是**界面**目录（带型号与名称）。报错了的话，看到「用例表内嵌」
    //    却同时看见真实型号名字，读的人会以为系统在自相矛盾。
    out.put("catalogOrigin", catalogOriginText());
    return out;
  }

  /** 这张表里的型号/名称到底来自哪一份目录（与 {@link #byRecipeId} 的取法逐条对应） */
  private String catalogOriginText() {
    final DbCatalog db = dbCatalog.getIfAvailable();
    if (db != null) {
      final Object products = db.uiPayload().get("products");
      if (products instanceof List<?> l && !l.isEmpty()) {
        return "数据库（" + l.size() + " 款）";
      }
    }
    return "内核目录（用例表内嵌 —— 只有 id 与占地，没有型号/名称）";
  }

  /**
   * 这一份方案的交付流转状态（界面上的状态徽标）。
   *
   * 与交付记录同一个口子取（而不是让界面再发一次 `GET /api/schemes/{id}`）：
   * 一次请求把「状态 + 交付历史 + 可勾选的件 + 三个视角」都给齐 —— 少一次往返，也少一处可能对不上的地方。
   */
  public String statusOf(long id) {
    return schemes.find(id, user.id())
        .orElseThrow(() -> ApiProblem.notFound("方案不存在（或已被删除）：id=" + id))
        .status();
  }

  // ── 内部 ────────────────────────────────────────────────────────────

  private static Delivery.Item item(String id) {
    return Delivery.item(id).orElseThrow(() -> new IllegalStateException("交付项表里没有：" + id));
  }

  private static List<Delivery.Item> selectedOrBadRequest(List<String> ids) {
    try {
      return Delivery.selected(ids);
    } catch (IllegalArgumentException e) {
      throw ApiProblem.badRequest("bad-delivery-items", e.getMessage());
    }
  }

  /**
   * 三张固定视角的截图（A13）：**数量必须是 3、顺序必须与服务端那张表一致**。
   *
   * 顺序这一条是**跨语言**的（浏览器在 `app/src/views3d.js` 里排、服务端在这里编号）——
   * 对不上的后果是"文件名写着俯视、图却是斜角"，而两张图各自都挺正常，拍照那一头永远发现不了。
   * 所以要求浏览器把**视角 id 一起发过来**，这一边逐位核一遍：对不上就 400（当场说清是哪一位）。
   */
  private static List<Delivery.Entry> shotEntries(List<String> shots, List<String> viewIds) {
    final List<String> got = shots == null ? List.of() : shots;
    if (got.size() != Delivery.VIEWS.size()) {
      throw ApiProblem.badRequest("shots-required",
          "三维截图要正好 " + Delivery.VIEWS.size() + " 张（" + String.join("、",
              Delivery.VIEWS.stream().map(Delivery.View::label).toList()) + "），这次收到 "
              + got.size() + " 张 —— 浏览器那边少截了一张");
    }
    final List<String> ids = viewIds == null ? List.of() : viewIds;
    final List<String> want = Delivery.VIEWS.stream().map(Delivery.View::id).toList();
    if (!ids.equals(want)) {
      throw ApiProblem.badRequest("shots-order",
          "三维截图的顺序与服务端的视角表对不上（收到 " + ids + "，应当是 " + want
              + "）—— 页面可能是旧版本的，刷新一下再来；这一条不核对的话，"
              + "包里的文件名会与图的内容错位，而两张图单看都正常");
    }
    final List<Delivery.Entry> out = new ArrayList<>();
    for (int i = 0; i < got.size(); i++) {
      final Delivery.View v = Delivery.VIEWS.get(i);
      // 复用封面的图片校验器（同一块画布、同样的尺寸上限）—— 但**话术要说这一件是什么**，
      // 不然用户看到"封面太大"会去找封面，而问题出在三维截图
      try {
        out.add(new Delivery.Entry(v.name(),
            CoverImage.decode(got.get(i), "三维截图「" + v.label() + "」").bytes()));
      } catch (IllegalArgumentException e) {
        throw ApiProblem.badRequest("bad-shot", e.getMessage());
      }
    }
    return out;
  }

  /**
   * 可选附件：**这一份方案用到的**那些型号的 GLB（不是整个目录）。
   *
   * 少了文件就写进 `missing`（不补、不假装）：附件里少了哪一款，交付团队要能一眼看到。
   * ⚠️ 场景 GLB（整个房间导出一个）这一版**没做** —— 只带产品模型。README 里如实写着。
   */
  private List<Delivery.Entry> assetEntries(Map<String, Object> state,
                                            Map<String, Map<String, Object>> byId,
                                            List<String> missing) {
    final List<Delivery.Entry> out = new ArrayList<>();
    final Set<String> seen = new LinkedHashSet<>();
    for (final String code : Delivery.groupByModel(state).keySet()) {
      final Map<String, Object> p = byId.get(code);
      final String file = p == null ? "" : String.valueOf(p.getOrDefault("file", "")).trim();
      if (file.isEmpty()) {
        missing.add(code + " 的 GLB（目录里这一款没有模型文件）");
        continue;
      }
      if (!seen.add(file)) continue;   // 同一份文件只用带一次
      final Path f = Paths.get(file).toAbsolutePath().normalize();
      if (!Files.isReadable(f)) {
        missing.add(code + " 的 GLB（文件不在：" + file + "）");
        continue;
      }
      try {
        out.add(new Delivery.Entry(Delivery.ATTACH_DIR + f.getFileName(), Files.readAllBytes(f)));
      } catch (IOException ex) {
        missing.add(code + " 的 GLB（读不出来：" + ex.getMessage() + "）");
      }
    }
    if (out.isEmpty()) missing.add("GLB 附件（这一包里一款都没带上）；另：场景 GLB 这一版还没做导出");
    return out;
  }

  private static List<Map<String, Object>> manifestOf(List<Delivery.Entry> entries) {
    final List<Map<String, Object>> out = new ArrayList<>();
    for (final Delivery.Entry e : entries) {
      final Map<String, Object> m = new LinkedHashMap<>();
      m.put("name", e.name());
      m.put("bytes", e.bytes().length);
      m.put("checksum", Delivery.md5(e.bytes()));
      out.add(m);
    }
    return out;
  }

  /** 包文件名：`方案名_vN_时间.zip` —— 桌面上放着几个包时，一眼认得出哪个是新的 */
  private static String fileName(String schemeName, int rev, LocalDateTime at) {
    final String safe = schemeName == null ? "方案" : schemeName.replaceAll("[\\\\/:*?\"<>|\\s]+", "-");
    return safe + "_v" + rev + "_" + String.format("%04d%02d%02d-%02d%02d",
        at.getYear(), at.getMonthValue(), at.getDayOfMonth(), at.getHour(), at.getMinute()) + ".zip";
  }

  /**
   * 目录的界面形状（型号 / 名称 / 占地 / 尺寸可信度），按**运行时 id**（= `recipe_json.id`）索引。
   *
   * 没有数据库（`spatial.store=memory`）时：目录里能拿到的只有 id 与占地（内核目录），
   * **没有名称** —— 于是 CSV/README 里会写"目录里没有这一款"，而不是编一个名字。
   * 宁可难看，不要编。
   */
  @SuppressWarnings("unchecked")
  private Map<String, Map<String, Object>> byRecipeId() {
    final Map<String, Map<String, Object>> out = new LinkedHashMap<>();
    final DbCatalog db = dbCatalog.getIfAvailable();
    if (db != null) {
      final Object products = db.uiPayload().get("products");
      if (products instanceof List<?> list) {
        for (final Object o : list) {
          if (o instanceof Map<?, ?> m) {
            final Map<String, Object> p = (Map<String, Object>) m;
            final String id = String.valueOf(p.getOrDefault("id", "")).trim();
            if (!id.isEmpty()) out.put(id, p);
          }
        }
        if (!out.isEmpty()) return out;
      }
    }
    // 无库档：只有 id 与占地（米 → 毫米），其余留空
    final Catalog c = catalogs.current();
    for (final String id : c.ids()) {
      final double[] fp = c.footprint(id);
      final Map<String, Object> p = new LinkedHashMap<>();
      p.put("id", id);
      p.put("model", id);
      p.put("name", "");
      p.put("file", "");
      if (fp != null) {
        p.put("w", fp[0] * 1000);
        p.put("d", fp[1] * 1000);
      }
      out.put(id, p);
    }
    return out;
  }

  /** `audit_json` 在库里是文本，交付包里要变成对象 —— **解析不了就大声报**（那是数据损坏） */
  @SuppressWarnings("unchecked")
  private static Map<String, Object> readStored(SchemeStore.SchemeRow row) {
    final String s = row.auditJson();
    if (s == null || s.isBlank()) return null;
    try {
      return JSON.readValue(s, Map.class);
    } catch (Exception e) {
      throw new IllegalStateException("scheme.audit_json 无法解析（这一列是我们自己写的）", e);
    }
  }

  private static String jsonOf(Object o) {
    try {
      return JSON.writeValueAsString(o);
    } catch (Exception e) {
      throw new IllegalStateException("交付记录无法序列化（这是代码缺陷）", e);
    }
  }

  @SuppressWarnings("unchecked")
  private static List<Map<String, Object>> parseFiles(String filesJson) {
    if (filesJson == null || filesJson.isBlank()) return List.of();
    try {
      return JSON.readValue(filesJson, List.class);
    } catch (Exception e) {
      throw new IllegalStateException("scheme_delivery.files_json 无法解析（这一列是我们自己写的）", e);
    }
  }

  /** 生成人：**存名字快照**（`V9` 建 `updated_by` 那列的原话："人可停用、记录要留"） */
  private String actorName() {
    return user.username();
  }
}