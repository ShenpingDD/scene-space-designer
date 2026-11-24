package com.scene.spatial.admin;

import com.scene.spatial.api.ApiProblem;
import com.scene.spatial.auth.AuthUser;
import com.scene.spatial.auth.CurrentUser;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * AdminService —— 维护端的**装配层**（R6-1）
 *
 * 职责只有一件：把仓储取回的行，装成界面要的形状。判断都在纯函数里
 * （`AdminBadges` / `AdminGate`），这样它们能被单测钉住。
 *
 * 为什么用 `ObjectProvider`：维护端必须能在**没有数据库**的档位（`spatial.store=memory`）下
 * **起得来**，哪怕它什么也读不到 —— 起来的服务和起不来的服务，排查成本差一个量级。
 * 读不到就说读不到（`store: memory`），不许静默返回空列表假装"没有产品"（判据 5「怕安静」）。
 */
@Service
public class AdminService {

  private final ObjectProvider<AdminRepository> repo;
  private final CurrentUser currentUser;

  public AdminService(ObjectProvider<AdminRepository> repo, CurrentUser currentUser) {
    this.repo = repo;
    this.currentUser = currentUser;
  }

  /** 当前数据来源档位 —— 界面要把它显示出来（不显示的话，"怎么是空的"就没人答得上来） */
  public String storeMode() {
    return repo.getIfAvailable() == null ? "memory" : "jdbc";
  }

  /** `id → 显示名`（审计要用）。取不到就是空 map —— 界面显示原始 id，不编名字 */
  public Map<String, String> userNames() {
    final AdminRepository r = repo.getIfAvailable();
    return r == null ? Map.of() : r.userNames();
  }

  /**
   * `id → 启用状态`（维护端方案库的卡片要标「所属账号已停用」）。
   *
   * 账号停用之后，他建的方案全部保留 —— 界面上要能看出这是「人停了」，方案本身没有问题。
   */
  public Map<String, Boolean> userEnabled() {
    final AdminRepository r = repo.getIfAvailable();
    final Map<String, Boolean> out = new LinkedHashMap<>();
    if (r == null) return out;
    for (final Map<String, Object> u : r.userDirectory()) {
      out.put(String.valueOf(u.get("id")), AdminGate.enabled(u.get("enabled")));
    }
    return out;
  }

  /**
   * 我（身份 + 权限 + 数据来源）。
   *
   * 身份来自**登录会话**（`CurrentUser`），不再从库里挑"id 最小的那一行"——
   * 无库档（`local-nodb`）没有 `sys_user` 表，那时取固定的本机身份（id=1 / admin）。
   * 能力表仍然只在这里给一次，前端照着它显示。
   */
  public Map<String, Object> me() {
    final AuthUser u = currentUser.orNull();
    final String role = u == null ? "" : u.roleCode();
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("store", storeMode());
    out.put("userId", u == null ? null : u.id());
    out.put("username", u == null ? null : u.username());
    out.put("displayName", u == null ? null : u.displayName());
    out.put("roleCode", role);
    out.put("isAdmin", AdminGate.canAdmin(role));
    // 四档能力表（R6-4 B4e）：**判断只许有一处** —— 前端照着它显示，不自己抄一张对照表。
    // roleKnown 也要给：认不得的角色码必须让界面**说出来**（「按只读以下处理」），不许静默降级
    out.put("caps", AdminGate.caps(role));
    out.put("roleKnown", AdminGate.isKnown(role));
    out.put("knownRoles", AdminGate.ROLES);
    // 认证已经接上（U1）：身份来自登录账号，停用、改角色、改口令都在下一个请求生效
    out.put("authLanded", true);
    out.put("enabled", u == null ? null : u.enabled());
    return out;
  }

  /**
   * 角色门：角色不够就抛 403。
   *
   * **每个维护端接口都要过这一道** —— 不许指望"前端把它藏起来了"。前端藏的是入口，
   * 后端守的是数据；少了后者，换个地址栏就能绕过。
   */
  public void requireEnterAdmin() {
    require(AdminGate.canEnterAdmin(role()), "进入维护端",
        "四档里能进维护端的是 admin / editor / viewer");
  }

  /** 维护目录与产品（上传 GLB、建型号）—— admin / editor */
  public void requireMaintain() {
    require(AdminGate.canMaintain(role()), "维护产品与目录",
        "这一档只有 admin / editor 能做（designer 走前台设计器，viewer 只读）");
  }

  /** 发布规则参数 —— **只有 admin**（设计决策记录 §风险表：参数是全局口径，一人改、所有人变） */
  public void requirePublishParams() {
    require(AdminGate.canPublishParams(role()), "发布规则参数",
        "参数一改，所有人的判定口径都跟着变，所以只有 admin 能发（editor 能维护产品与方案）");
  }

  /** 管用户 —— **只有 admin**（建号、改角色、重置口令都是把权限交出去的动作） */
  public void requireManageUsers() {
    require(AdminGate.canManageUsers(role()), "管理账号",
        "建号、改角色、重置口令都是把权限交出去的动作，所以只有 admin 能做");
  }

  /** 改方案 —— 前台设计师（designer）+ 维护端管方案库的人（admin / editor） */
  public void requireWriteSchemes() {
    require(AdminGate.canWriteSchemes(role()), "新建/修改方案",
        "能改方案的是 admin / editor / designer；viewer 只读");
  }

  /** 当前登录账号的角色码（**认不得就是认不得**，不猜） */
  public String role() {
    return currentUser.roleCode();
  }

  /** 审计里的「谁」：显示名优先，退回登录名（没有会话时为空，不编名字） */
  public String actor() {
    final AuthUser u = currentUser.orNull();
    if (u == null) return "";
    final String name = u.displayName();
    return name == null || name.isBlank() ? u.username() : name;
  }

  /**
   * 门的具体做法：不给就 403，并且**把原话说出来**（谁的档位、这一档为什么不够）。
   * 档位来自登录账号的 `role_code`（`AccountFreshnessFilter` 每次请求复核一次）。
   */
  private void require(boolean allowed, String what, String why) {
    if (allowed) return;
    throw ApiProblem.forbidden("你的角色（" + (role().isBlank() ? "（空）" : role()) + "）不能" + what
        + "：" + why + "。这个判断来自登录账号的 role_code（见 AdminGate），要换档位找管理员改");
  }

  /**
   * 变体按产品分组：一次取回来再分组（理由见 AdminRepository.allModels）。
   *
   * `products()`（列表）与 `productCard()`（单条）**共用这一份** —— 分组的键语义只此一处，
   * 两边不会因为「一边按 Long 一边按 String 分组」而各自取空。
   */
  private static Map<Object, List<Map<String, Object>>> groupModels(AdminRepository r) {
    final Map<Object, List<Map<String, Object>>> byProduct = new LinkedHashMap<>();
    for (final Map<String, Object> m : r.allModels()) {
      byProduct.computeIfAbsent(m.get("product_id"), k -> new ArrayList<>()).add(m);
    }
    return byProduct;
  }

  /** 产品卡片列表（含停用；**一条都不滤**） */
  public List<Map<String, Object>> products() {
    final AdminRepository r = repo.getIfAvailable();
    if (r == null) return List.of();
    final Map<Object, List<Map<String, Object>>> byProduct = groupModels(r);
    final List<Map<String, Object>> out = new ArrayList<>();
    for (final Map<String, Object> row : r.products()) {
      out.add(card(row, byProduct.get(row.get("db_id"))));
    }
    return out;
  }

  /**
   * **一款产品的卡片**（形状与列表里的那一条逐键相同）。
   *
   * 停用/启用之后要把这张卡原样还给界面就地替换 —— 界面读的是**卡片**（`badges` / `model` /
   * `variants` / `variantCount` …），不是数据库的列。只回 `productById()` 的五列时，`badges`
   * 是 `undefined`，角标区会抛 `TypeError`（第 3 轮审查 `C-15`）。
   *
   * 形状由 `AdminCardShapeTest` 钉住：界面读得到什么，这里就必须给什么。
   */
  public Map<String, Object> productCard(long id) {
    final AdminRepository r = repo.getIfAvailable();
    if (r == null) return null;
    final Map<String, Object> row = r.productRowById(id);
    if (row == null) return null;
    return card(row, groupModels(r).get(row.get("db_id")));
  }

  /** 一款产品（给“加变体”验存在用）—— 按 id 查、不按状态滤：停用的也能加，它迟早要修好 */
  public Map<String, Object> product(long id) {
    final AdminRepository r = repo.getIfAvailable();
    return r == null ? null : r.productById(id);
  }

  /**
   * 变体清单：**每一份模型各自就绪了没有**。
   *
   * 卡片上本来就有一列默认变体的 file_path —— 一变体之后就回答不了
   * “我刚加的那个渲完了吗”。就绪的判据只有一条：**产物文件在不在**
   * （前台就是照它去加载的，不是看 LOD 层数）。
   */
  private static List<Map<String, Object>> variants(List<Map<String, Object>> models) {
    final List<Map<String, Object>> out = new ArrayList<>();
    for (final Map<String, Object> m : models == null ? List.<Map<String, Object>>of() : models) {
      final String variant = String.valueOf(m.get("variant"));
      final Map<String, Object> v = new LinkedHashMap<>();
      v.put("variant", variant);
      v.put("file", m.get("file_path"));
      v.put("fileBytes", m.get("file_size"));
      v.put("sourceFile", m.get("source_file_path"));
      v.put("bboxW", m.get("bbox_w"));
      v.put("bboxD", m.get("bbox_d"));
      v.put("bboxH", m.get("bbox_h"));
      v.put("ready", !String.valueOf(m.get("file_path") == null ? "" : m.get("file_path")).isBlank());
      v.put("isDefault", "default".equals(variant));
      // 没就绪时把原因带上（LOD 失败会写 lodError）—— 否则界面只能说“没就绪”，用户无从下手
      v.put("lodError", lodErrorOf(m.get("delta_vs_source_json")));
      out.add(v);
    }
    return out;
  }

  /** 从 delta_vs_source_json 里取 LOD 失败原因（换过好几版结构，取不到就空串，不猜）。 */
  private static String lodErrorOf(Object deltaJson) {
    final String s = deltaJson == null ? "" : String.valueOf(deltaJson).trim();
    if (s.isEmpty() || "null".equals(s)) return "";
    try {
      final Object parsed = com.scene.spatial.kernel.Json.parse(s);
      if (!(parsed instanceof Map)) return "";
      final Object v = ((Map<?, ?>) parsed).get("lodError");
      return v == null ? "" : String.valueOf(v);
    } catch (RuntimeException e) {
      return "";   // 解析不了就当没写（这个字段是可选的；解析失败不该让整张卡片消失）
    }
  }

  /** 一行 → 一张卡片（`static`：不依赖实例状态，好让 `AdminCardShapeTest` 直接钉形状） */
  static Map<String, Object> card(Map<String, Object> row, List<Map<String, Object>> models) {
    final List<Map<String, Object>> badges = AdminBadges.of(row);
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("id", row.get("db_id"));
    m.put("recipeId", row.get("recipe_id"));      // 前端拿它去查缩略图（与目录同一套 id）
    m.put("modelNo", row.get("model_no"));
    m.put("name", row.get("name"));
    m.put("series", row.get("series"));
    m.put("description", row.get("description"));
    m.put("origin", row.get("origin"));
    // “这份数据是不是供应商按规范交的”由这里给结论（界面零业务判断，它只把结论写成一句人话）
    m.put("originManual", ProductDraft.originIsManual(row.get("origin")));
    m.put("sizeNote", row.get("size_note"));
    m.put("doorPart", row.get("door_part"));
    m.put("doorVerified", row.get("door_verified"));   // 0=没确认过 → 规则7 体检算不准
    m.put("doorSource", row.get("door_source"));       // user / admin / auto（英文代码，中文在界面）
    m.put("color", row.get("color"));
    m.put("sourceUrl", row.get("source_url"));
    m.put("status", row.get("status"));
    m.put("sortOrder", row.get("sort_order"));
    m.put("createdAt", row.get("created_at"));
    m.put("updatedAt", row.get("updated_at"));
    m.put("updatedBy", row.get("updated_by"));         // owner 是"创建的"，这是"最近谁改的"
    // 模型侧（**实测**口径 —— 不拿声明值冒充实测值）
    final Map<String, Object> model = new LinkedHashMap<>();
    model.put("variant", row.get("variant"));
    model.put("file", row.get("file_path"));
    model.put("fileBytes", row.get("file_size"));
    model.put("sourceFile", row.get("source_file_path"));
    model.put("thumbFile", row.get("thumb_file"));
    model.put("checksum", row.get("checksum"));
    model.put("unit", row.get("unit"));
    model.put("bboxW", row.get("bbox_w"));
    model.put("bboxD", row.get("bbox_d"));
    model.put("bboxH", row.get("bbox_h"));
    // 验收-1：看板开门要读真实门/抽屉节点；原样保留 {node,axis,openAngleDeg,nodes?,hinge?}，
    // JSON 坏/空一律给 []，不把解析失败变成整张卡片 500。
    model.put("hingeNodes", hingeNodesOf(row.get("hinge_nodes")));
    model.put("envelopeMode", row.get("envelope_mode"));
    model.put("envelopeOk", row.get("envelope_ok"));
    model.put("anisotropyOk", row.get("anisotropy_ok"));  // 只在 fit 下有意义（1:1 无缩放）
    m.put("model", model);
    m.put("noteCount", row.get("note_count"));
    m.put("variantCount", row.get("variant_count"));
    m.put("variants", variants(models));   // 每一份模型各自的就绪情况（不止默认那一份）
    m.put("badges", badges);
    m.put("hasBad", AdminBadges.hasBad(badges));
    // P0：设计端为什么看不到这款产品 —— 判据只在这里（ProductVisibility），目录过滤不放宽
    m.put("frontVisible", ProductVisibility.visible(row));
    m.put("visibilityReason", ProductVisibility.reason(row));
    // 热门点/详情摘要：列表一次带出，界面不必逐卡请求（V18）
    final int contentRev = intOf(row.get("content_rev"));
    final int publishedRev = intOf(row.get("content_published_rev"));
    // 只报三态：V18 没存发布失败态，不能虚报 failed
    final String contentStatus = contentRev > 0 && (publishedRev == 0 || contentRev > publishedRev)
        ? "draft" : publishedRev > 0 ? "published" : "none";
    m.put("hotspotCount", intOf(row.get("hotspot_count")));
    m.put("contentRev", contentRev);
    m.put("publishedRev", publishedRev);
    m.put("contentStatus", contentStatus);
    m.put("hotspotStatus", contentStatus);
    return m;
  }

  /** `product_model.hinge_nodes` JSON → 数组；空/坏 JSON 都回空数组（卡片不能因此 500） */
  private static List<Object> hingeNodesOf(Object raw) {
    if (raw == null) return List.of();
    final String text = String.valueOf(raw).trim();
    if (text.isEmpty() || "null".equals(text)) return List.of();
    try {
      final Object parsed = com.scene.spatial.kernel.Json.parse(text);
      return parsed instanceof List<?> list ? new ArrayList<>(list) : List.of();
    } catch (RuntimeException e) {
      return List.of();
    }
  }

  private static int intOf(Object o) {
    if (o instanceof Number n) return n.intValue();
    if (o == null) return 0;
    try {
      return Integer.parseInt(String.valueOf(o).trim());
    } catch (NumberFormatException e) {
      return 0;
    }
  }

  /** 版本号比较（Flyway 的版本号是字符串，但 V8 > V10 这种坑必须避开 → 能转数字就按数字比） */
  private static int compareVersions(String a, String b) {
    try {
      return Integer.compare(Integer.parseInt(a), Integer.parseInt(b));
    } catch (NumberFormatException e) {
      return a.compareTo(b);
    }
  }

  /** 系统状态页：每一条都是**能被核对的数** */
  public Map<String, Object> system() {
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("store", storeMode());
    final AdminRepository r = repo.getIfAvailable();
    if (r == null) {
      out.put("available", false);
      out.put("hint", "当前档位没有数据库（spatial.store=memory）—— 维护端读不到任何数据，这是如实告知，不是「没有产品」");
      return out;
    }
    out.put("available", true);
    out.put("counts", r.counts());
    out.put("disk", r.disk());
    // ── LOD 判定：**不许只数文件个数** ──────────────────────────────────
    // 声明的三级（lod0/lod1/lod2）有两种合法归宿：① 出了文件；② **按设计跳过**。
    // 后者是优化器的刻意行为：压缩到模型自身的三角形下限后，再粗化得到的是**同一个文件**，
    // 于是故意不出这一级（免得白送一个重复文件）——实测 demo-ct-scanner 的 lod2 算出来 24270 面，
    // 而 lod1 是 24288 面（差 0.07%）；demo-freezer-chest 的 lod1 与 lod0 面数**完全相等**。
    // 第一版只数文件个数，把这件好事报成了"缺层" —— **假角标比没有角标更坏**，
    // 管理员发现一个角标在瞎报，就会开始不信所有角标。所以判定必须认得出"跳过"。
    final List<Map<String, Object>> lodRows = r.lodLevels();
    int full = 0;
    int byDesign = 0;
    final List<Map<String, Object>> thin = new ArrayList<>();
    for (final Map<String, Object> x : lodRows) {
      final int have = intOf(x.get("level_count"));
      final int skip = intOf(x.get("skipped_count"));
      if (have + skip >= 3) {
        full++;
        if (skip > 0) byDesign++;
      } else {
        // 真缺：把"缺几级"直接算出来给界面（别让人自己减）
        final Map<String, Object> t = new LinkedHashMap<>(x);
        t.put("missing", 3 - have - skip);
        thin.add(t);
      }
    }
    final Map<String, Object> lodInfo = new LinkedHashMap<>();
    lodInfo.put("models", lodRows.size());
    lodInfo.put("withThreeLevels", full);
    lodInfo.put("declaredLevels", 3);             // lod0 / lod1 / lod2 —— 判定口径写出来
    lodInfo.put("byDesign", byDesign);            // 其中几个是"按设计少出一级"（不是毛病，是优化到了下限）
    lodInfo.put("thin", thin);                    // **真缺**的才点名（不许只报总数）
    out.put("lod", lodInfo);
    // 迁移到哪一版了。**坑**：按 installed_rank 排最后一条通常是**可重复迁移**（version 为空），
    // 所以"最后一版"必须从**有版本号**的那些里取 —— 否则界面会显示成"没迁移过"（实测踩到）。
    final java.util.List<Map<String, Object>> migs = r.migrations();
    String lastVersioned = "";
    for (final Map<String, Object> m : migs) {
      final String v = m.get("version") == null ? "" : String.valueOf(m.get("version")).trim();
      if (!v.isEmpty() && (lastVersioned.isEmpty() || compareVersions(v, lastVersioned) > 0)) {
        lastVersioned = v;
      }
    }
    out.put("flywayLastVersioned", lastVersioned);
    out.put("migrationRows", migs.size());
    out.put("migrations", migs);
    out.put("me", me());
    return out;
  }
}
