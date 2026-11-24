package com.scene.spatial.admin;

import com.scene.spatial.api.ApiProblem;
import com.scene.spatial.kernel.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * ProductContentService —— 产品详情/热点的业务编排（V18，设计决策记录–§7）。
 *
 * 三条边界刻意分开：
 *   ① 校验（纯函数式，攒齐 issues 一次回）—— 结构性错误 422，不写库；
 *   ② tx1 编辑态（draft/热点）—— 由 repository 单独事务提交；
 *   ③ tx2 发布快照 —— 单独事务；失败时编辑态保留、旧快照继续对外。
 * 把 ②③ 合进一个 @Transactional 会让「发布失败」把编辑态一起回滚，正是 Lead 明确否掉的。
 */
@Service
@ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
public class ProductContentService {

  private static final Logger log = LoggerFactory.getLogger(ProductContentService.class);
  private static final int MAX_HOTSPOTS = 50;
  private static final int MAX_TITLE = 40;
  private static final int MAX_BODY = 300;
  private static final int MAX_SELLING = 8;
  private static final int MAX_SELLING_LEN = 200;
  private static final int MAX_PARAMS = 50;
  private static final int MAX_KEY = 40;
  private static final int MAX_VALUE = 200;
  private static final int MAX_UNIT = 16;
  private static final int MAX_GROUP = 40;
  private static final int MAX_SNAPSHOT_BYTES = 256 * 1024;
  /** 1,000 km；远大于任何真实家具，但低于 position 列 DECIMAL(12,4) 的上限，避免 DB 500。 */
  private static final double MAX_ABS_POSITION_M = 1_000_000.0;
  private static final Set<String> REASONS = Set.of(
      "anchor-missing", "index-out-of-range", "unit-mismatch", "model-changed");

  // ── V19 产品级动作库 ───────────────────────────────────────────────────
  // 动作是产品级的（一个 352 的「开门」动作，所有 352 的热点都能引用），所以键只需在产品内唯一。
  private static final int MAX_ACTIONS = 50;
  private static final int MAX_ACTION_KEY = 64;
  private static final int MAX_ACTION_NAME = 80;
  private static final int MAX_ACTION_CLIP = 128;
  private static final int MAX_ACTION_PATH_DEPTH = 16;
  private static final int MAX_ACTION_PATH_SEGMENT = 128;
  private static final int MIN_ACTION_DURATION_MS = 100;
  private static final int MAX_ACTION_DURATION_MS = 5000;
  /** 动作库和前端播放器共用这四个 kind；新增 kind 必须两边同时改。 */
  private static final Set<String> ACTION_KINDS = Set.of("rotate", "translate", "visibility", "clip");
  /**
   * action key 的身份口径：**小写** [a-z0-9_-]+（与 app/src/actions.js 生成端、MySQL ascii_bin 同一口径）。
   *
   * 为什么强制小写：key 会进动作库唯一键、热点引用与发布快照，大小写混用会得到
   * 「Door-Open」与「door-open」两个互不相认的身份；ascii_bin 又是区分大小写的。
   * 生成端只产小写，服务端这一侧必须同样只收小写（大写直接 422，不悄悄改写）。
   */
  private static final java.util.regex.Pattern ACTION_KEY_PATTERN =
      java.util.regex.Pattern.compile("[a-z0-9_-]+");

  private final ProductContentRepository repo;
  private final AuditLog audit;

  public ProductContentService(ProductContentRepository repo, AuditLog audit) {
    this.repo = repo;
    this.audit = audit;
  }

  /** 维护端读取：编辑态 + 已发布摘要 + 当前模型/问题（GET /content） */
  public Map<String, Object> adminContent(long productId) {
    final Map<String, Object> header = headerOrThrow(productId);
    final Map<String, Object> row = repo.contentRow(productId);
    final Draft draft = draftOf(row);
    final List<Map<String, Object>> hotspots = hotspotViews(repo.hotspots(productId));
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("productId", productId);
    out.put("catalogId", str(header.get("catalog_id")));
    out.put("status", str(header.get("status")));
    out.put("rev", revOf(row));
    out.put("publishedRev", publishedRevOf(row));
    out.put("description", str(header.get("description")));
    out.put("draft", Map.of("sellingPoints", draft.sellingPoints(), "params", draft.params()));
    out.put("hotspots", hotspots);
    out.put("actions", actionViews(repo.actions(productId)));
    out.put("published", publishedSummary(row));
    out.put("model", adminModelView(header));
    out.put("issues", warnings(draft.validation()));
    out.put("dirty", revOf(row) != publishedRevOf(row));
    return out;
  }

  /**
   * 保存内容。
   * - body 带 `hotspots` → 105 的合并入口：tx1（内容+热点）+ 自动 tx2 发布；
   * - body 不带 → 106 规范序列的第 1 步：只写编辑态，不发布。
   */
  public Map<String, Object> saveContent(long productId, Map<String, Object> body, String actor) {
    final Map<String, Object> header = headerOrThrow(productId);
    final Map<String, Object> row = repo.contentRow(productId);
    final Draft current = draftOf(row);
    final int expected = expectedRev(body, row);
    if (expected != revOf(row)) throw ApiProblem.staleContentRev(revOf(row));

    final List<Map<String, Object>> issues = new ArrayList<>();
    checkModelId(body, header, issues);
    final List<String> selling = stringList(body.containsKey("sellingPoints")
        ? body.get("sellingPoints") : current.sellingPoints(), "sellingPoints", MAX_SELLING,
        MAX_SELLING_LEN, issues);
    final List<Map<String, Object>> params = paramList(body.containsKey("params")
        ? body.get("params") : current.params(), issues);
    final Map<String, Object> validation = body.containsKey("validation")
        ? validationOf(body.get("validation"), header) : current.validation();

    final List<Map<String, Object>> existingActions = repo.actions(productId);
    // 传了 actions 就在本次 tx1 里整体替换动作库；没传就保留（旧客户端不受影响）。
    final boolean actionsGiven = body.containsKey("actions");
    final List<Map<String, Object>> actions = actionsGiven
        ? normalizeActions(body.get("actions"), issues) : null;
    // 热点只能指向「本次提交的动作库」或「库里现有的动作库」里的键，否则保存后就是悬空引用。
    final Set<String> allowedKeys = actionKeys(actionsGiven ? actions : existingActions);

    final boolean combined = body.containsKey("hotspots");
    List<Map<String, Object>> hotspots = null;
    List<Map<String, Object>> existingHotspots = List.of();
    if (combined) {
      existingHotspots = repo.hotspots(productId);
      hotspots = normalizeHotspots(body.get("hotspots"), header, existingHotspots, allowedKeys, issues);
    }
    if (!issues.isEmpty()) throw ApiProblem.contentInvalid(issues, "保存被拒：" + issues.size() + " 条问题");

    final List<Map<String, Object>> snapshotActions = actionsGiven ? actions : actionViews(existingActions);
    final int actionCount = snapshotActions.size();
    final String draftJson = draftJson(selling, params, validation);
    if (combined) {
      final int nextRev = expected + 1;
      final String snapshot = snapshotJson(header, new Draft(selling, params, validation),
          hotspots, snapshotActions, nextRev, null);
      if (utf8(snapshot) > MAX_SNAPSHOT_BYTES) {
        throw ApiProblem.contentInvalid(List.of(issue("content-too-large", "发布快照超过 256 KB")),
            "保存被拒：发布快照超过 256 KB");
      }
      final List<Long> ids = repo.saveContentAndHotspots(productId, draftJson, hotspots, actions,
          expected, actor);
      if (ids == null) throw ApiProblem.staleContentRev(revOf(repo.contentRow(productId)));
      final int invalid = invalidCount(validation);
      auditSave(header, nextRev, selling.size(), params.size(), hotspots.size(), ids,
          existingHotspots, invalid, actionCount, actor);
      final PublishOutcome po = publishInternal(productId, header, actor, nextRev, null);
      final Map<String, Object> out = savedResponse(nextRev, ids, invalid, validation);
      out.putAll(po.body());
      return out;
    }

    ensureSnapshotFits(header, new Draft(selling, params, validation),
        hotspotViews(repo.hotspots(productId)), snapshotActions, expected + 1, null);
    if (!repo.saveDraft(productId, draftJson, actions, expected, actor)) {
      throw ApiProblem.staleContentRev(revOf(repo.contentRow(productId)));
    }
    auditSave(header, expected + 1, selling.size(), params.size(), 0, List.of(),
        List.of(), invalidCount(validation), actionCount, actor);
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("rev", expected + 1);
    out.put("published", false);
    out.put("publishedRev", publishedRevOf(repo.contentRow(productId)));
    out.put("hotspotIds", List.of());
    out.put("invalidCount", invalidCount(validation));
    out.put("warnings", warnings(validation));
    return out;
  }

  /** 106 规范序列第 2 步：只写热点编辑态（validation 一并存进 draft_json），不发布。 */
  public Map<String, Object> saveHotspots(long productId, Map<String, Object> body, String actor) {
    final Map<String, Object> header = headerOrThrow(productId);
    final Map<String, Object> row = repo.contentRow(productId);
    final Draft current = draftOf(row);
    final int expected = expectedRev(body, row);
    if (expected != revOf(row)) throw ApiProblem.staleContentRev(revOf(row));
    final List<Map<String, Object>> issues = new ArrayList<>();
    checkModelId(body, header, issues);
    final List<Map<String, Object>> existingHotspots = repo.hotspots(productId);
    final List<Map<String, Object>> existingActions = repo.actions(productId);
    final boolean actionsGiven = body.containsKey("actions");
    final List<Map<String, Object>> actions = actionsGiven
        ? normalizeActions(body.get("actions"), issues) : null;
    final Set<String> allowedKeys = actionKeys(actionsGiven ? actions : existingActions);
    final List<Map<String, Object>> hotspots = normalizeHotspots(
        body.get("hotspots"), header, existingHotspots, allowedKeys, issues);
    final Map<String, Object> validation = body.containsKey("validation")
        ? validationOf(body.get("validation"), header) : current.validation();
    if (!issues.isEmpty()) throw ApiProblem.contentInvalid(issues, "保存被拒：" + issues.size() + " 条问题");

    final List<Map<String, Object>> snapshotActions = actionsGiven ? actions : actionViews(existingActions);
    ensureSnapshotFits(header, current, hotspots, snapshotActions, expected + 1, null);
    final String draftJson = draftJson(current.sellingPoints(), current.params(), validation);
    final List<Long> ids = repo.saveHotspots(productId, draftJson, hotspots, actions, expected, actor);
    if (ids == null) throw ApiProblem.staleContentRev(revOf(repo.contentRow(productId)));
    auditSave(header, expected + 1, current.sellingPoints().size(), current.params().size(),
        hotspots.size(), ids, existingHotspots, invalidCount(validation), snapshotActions.size(), actor);
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("rev", expected + 1);
    out.put("hotspotIds", ids);
    out.put("invalidCount", invalidCount(validation));
    out.put("warnings", warnings(validation));
    out.put("published", false);
    return out;
  }

  /** 106 规范序列第 3 步：把当前编辑态写成发布快照。 */
  public Map<String, Object> publish(long productId, Map<String, Object> body, String actor) {
    final Map<String, Object> header = headerOrThrow(productId);
    final Map<String, Object> row = repo.contentRow(productId);
    final int currentRev = revOf(row);
    final int expected = expectedRev(body, row);
    if (row == null || expected != currentRev) throw ApiProblem.staleContentRev(currentRev);
    // 结构性超限在写之前拦（105 §6.2：422 且两段都不写）
    ensureSnapshotFits(header, draftOf(row), hotspotViews(repo.hotspots(productId)),
        actionViews(repo.actions(productId)), currentRev,
        body.get("validation"));
    final PublishOutcome po = publishInternal(productId, header, actor, currentRev, body.get("validation"));
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("rev", currentRev);
    out.putAll(po.body());
    out.put("invalidCount", invalidCount(po.validation()));
    out.put("warnings", warnings(po.validation()));
    return out;
  }

  /** 设计端详情（公共读）：only published；老产品走只读投影。 */
  public Detail detail(String catalogId) {
    final Map<String, Object> header = repo.productByCatalogId(catalogId);
    if (header == null) throw ApiProblem.productNotFound("产品不存在或已停用：" + catalogId);
    final Map<String, Object> row = repo.contentRow(num(header.get("db_id")));
    if (row == null) return new Detail(legacyDetail(header), etag(header, 0, "legacy"));
    final int publishedRev = publishedRevOf(row);
    final String published = str(row.get("published_json"));
    if (published.isBlank() || "null".equals(published)) {
      throw ApiProblem.contentNotPublished("这款产品还没有已发布的内容（目录不应显示详情入口）");
    }
    final Map<String, Object> snap = mapOf(published);
    final List<Map<String, Object>> hotspotList = mapList(snap.get("hotspots"));
    // 旧快照（V18 发布）没有 actions → 空数组；新快照原样透出
    final List<Map<String, Object>> actions = mapList(snap.get("actions"));
    final Map<String, Object> validation = mapOf(snap.get("validation"));
    final String currentFp = fingerprint(header);
    final String snapshotFp = str(validation.get("modelFingerprint"));
    final boolean modelChanged = !currentFp.isBlank() && !currentFp.equals(snapshotFp);

    final List<Map<String, Object>> invalid;
    final Set<Long> invalidIds = new LinkedHashSet<>();
    if (modelChanged) {
      // model-changed 优先于编辑器理由：模型都换了，旧锚点结论不再可信
      invalid = new ArrayList<>();
      for (final Map<String, Object> h : hotspotList) {
        final long id = num(h.get("id"));
        invalidIds.add(id);
        invalid.add(invalidReason(id, "model-changed", "模型文件已变更（" + currentFp + "），热点需重新校准"));
      }
    } else {
      invalid = invalidList(validation);
      for (final Map<String, Object> inv : invalid) invalidIds.add(num(inv.get("hotspotId")));
    }

    final List<Map<String, Object>> valid = new ArrayList<>();
    for (final Map<String, Object> h : hotspotList) {
      if (!invalidIds.contains(num(h.get("id")))) valid.add(h);
    }
    // 旧快照的热点没有 actionKey：补 null 而不是缺键，客户端读到的形状才是稳定的
    for (int i = 0; i < valid.size(); i++) {
      final Map<String, Object> h = new LinkedHashMap<>(valid.get(i));
      if (!h.containsKey("actionKey")) h.put("actionKey", null);
      valid.set(i, h);
    }
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("catalogId", str(header.get("catalog_id")));
    out.put("modelNo", str(header.get("model_no")));
    out.put("name", str(header.get("name")));
    out.put("publishedRev", publishedRev);
    out.put("publishedAt", publishedAtOf(row));
    out.put("unit", "m");
    out.put("coordSpace", "node-local");
    out.put("source", "published");
    out.put("limits", Map.of("hotspots", MAX_HOTSPOTS, "actions", MAX_ACTIONS));
    out.put("model", modelView(header));
    out.put("content", mapOf(snap.get("content")));
    out.put("actions", actions);
    out.put("hotspots", valid);
    out.put("counts", Map.of("total", hotspotList.size(), "valid", valid.size(),
        "invalid", hotspotList.size() - valid.size()));
    out.put("invalidReasons", invalid);
    return new Detail(out, etag(header, publishedRev, "published"));
  }

  // ── 内部：发布 ────────────────────────────────────────────────────────

  private PublishOutcome publishInternal(long productId, Map<String, Object> header, String actor,
                                         int rev, Object submittedValidation) {
    final Map<String, Object> row = repo.contentRow(productId);
    final Draft draft = draftOf(row);
    final Map<String, Object> validation = submittedValidation == null
        ? draft.validation() : validationOf(submittedValidation, header);
    final String snapshot = snapshotJson(header, draft, hotspotViews(repo.hotspots(productId)),
        actionViews(repo.actions(productId)), rev, validation);
    if (utf8(snapshot) > MAX_SNAPSHOT_BYTES) {
      auditPublish(header, rev, publishedRevOf(row), false, draft, validation, snapshot,
          "发布快照超过 256 KB", actor);
      return PublishOutcome.failed("publish-failed", "发布快照超过 256 KB；线上仍是第 "
          + publishedRevOf(row) + " 版", publishedRevOf(row), validation);
    }
    try {
      if (!repo.publish(productId, snapshot, rev, actor)) {
        auditPublish(header, rev, publishedRevOf(row), false, draft, validation, snapshot,
            "发布版本冲突（当前 rev 已变化）", actor);
        return PublishOutcome.failed("publish-failed", "发布版本冲突（当前 rev 已变化），请刷新后重试",
            publishedRevOf(row), validation);
      }
    } catch (RuntimeException e) {
      log.error("[content] 发布快照写入失败 product={} rev={}", productId, rev, e);
      auditPublish(header, rev, publishedRevOf(row), false, draft, validation, snapshot,
          e.getMessage(), actor);
      return PublishOutcome.failed("publish-failed", "发布步骤失败：" + e.getMessage(),
          publishedRevOf(row), validation);
    }
    auditPublish(header, rev, rev, true, draft, validation, snapshot, null, actor);
    return new PublishOutcome(true, rev, DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(OffsetDateTime.now()),
        validation, null, null);
  }

  // ── 内部：校验 ────────────────────────────────────────────────────────

  private List<Map<String, Object>> normalizeHotspots(Object raw, Map<String, Object> header,
                                                      List<Map<String, Object>> existing,
                                                      Set<String> allowedActionKeys,
                                                      List<Map<String, Object>> issues) {
    if (!(raw instanceof List<?> list)) {
      issues.add(issue("hotspot-invalid", "hotspots 必须是数组"));
      return List.of();
    }
    if (list.size() > MAX_HOTSPOTS) {
      issues.add(issue("hotspot-too-many", "热点最多 " + MAX_HOTSPOTS + " 条，当前 " + list.size()));
    }
    final Set<Long> existingIds = new LinkedHashSet<>();
    for (final Map<String, Object> e : existing) existingIds.add(num(e.get("id")));
    final long defaultModel = num(header.get("model_id"));
    final boolean modelReady = defaultModel > 0 && !str(header.get("file_path")).isBlank();
    final List<Map<String, Object>> out = new ArrayList<>();
    for (int i = 0; i < list.size(); i++) {
      final Object item = list.get(i);
      if (!(item instanceof Map<?, ?> rawMap)) {
        issues.add(issue("hotspot-invalid", "第 " + (i + 1) + " 条热点不是对象"));
        continue;
      }
      @SuppressWarnings("unchecked")
      final Map<String, Object> h = (Map<String, Object>) rawMap;
      final long id = num(h.get("id"));
      if (id > 0 && !existingIds.contains(id)) {
        throw ApiProblem.coded(409, "conflict", "hotspot-id-conflict",
            "热点 id " + id + " 不属于该产品，请刷新后重试", null);
      }
      if (!modelReady) {
        issues.add(issue("hotspot-model-invalid", "默认模型没有产物文件，不能保存热点"));
        break;
      }
      final long modelId = h.get("modelId") == null ? defaultModel : num(h.get("modelId"));
      if (modelId != defaultModel) {
        issues.add(issue("hotspot-model-invalid", "modelId 必须是该产品的 default 变体：" + modelId));
      }
      final String title = str(h.get("title")).trim();
      final String body = str(h.get("body")).trim();
      // 设计决策记录 / PRD 103：标题 1..40、正文 1..300；空值必须在写库前拦住，
      // 不能出现“200 + 已发布但热点没有可读内容”的假成功（P0-QA-07）。
      if (title.isEmpty()) {
        issues.add(issue("hotspot-invalid", "第 " + (i + 1) + " 条标题必填（1~" + MAX_TITLE + " 字）", id));
      } else if (title.length() > MAX_TITLE) {
        issues.add(issue("hotspot-invalid", "第 " + (i + 1) + " 条标题超过 " + MAX_TITLE + " 字", id));
      }
      if (body.isEmpty()) {
        issues.add(issue("hotspot-invalid", "第 " + (i + 1) + " 条正文必填（1~" + MAX_BODY + " 字）", id));
      } else if (body.length() > MAX_BODY) {
        issues.add(issue("hotspot-invalid", "第 " + (i + 1) + " 条正文超过 " + MAX_BODY + " 字", id));
      }
      if (h.containsKey("nodePath") && !(h.get("nodePath") instanceof List<?>)) {
        issues.add(issue("hotspot-invalid", "nodePath 必须是数组", id));
      }
      final List<Object> path = listOf(h.get("nodePath"));
      if (path.size() > 16) issues.add(issue("hotspot-invalid", "nodePath 最多 16 层", id));
      for (final Object seg : path) {
        if (str(seg).isBlank() || str(seg).length() > 128) {
          issues.add(issue("hotspot-invalid", "nodePath 每层必须非空且 ≤128 字符", id));
          break;
        }
      }
      final int nodeIndex = (int) num(h.get("nodeIndex"));
      if (nodeIndex < 0 || nodeIndex > 10000) {
        issues.add(issue("hotspot-invalid", "nodeIndex 必须在 0..10000", id));
      }
      final Map<String, Object> pos = mapOf(h.get("position"));
      final Double px = dbl(pos.get("x"));
      final Double py = dbl(pos.get("y"));
      final Double pz = dbl(pos.get("z"));
      // ⚠️ 这里只能校验有限数，**不能拿 position 和模型全局 bbox 比**。
      // position 是「锚点节点局部米」（105 §5.1 / 106 §2.2），锚点原点可能在任何地方：
      // DEMO-SC-100E 的 body 原点在 y=0.995 m，底部点的局部 y≈-0.995；全局 bbox 的下限却是
      // -0.5 m —— 合法标注会被误判成越界（验收-3 实测 422 hotspot-out-of-bounds）。
      // 服务端不解析 GLB，既不知道锚点原点在世界哪里，也无法把局部坐标换回世界；
      // 真正的锚点失效/单位问题由编辑器随 validation 快照上报，不在这一层猜。
      if (px == null || py == null || pz == null || !finite(px) || !finite(py) || !finite(pz)) {
        issues.add(issue("hotspot-invalid", "position 必须是三个有限数", id));
      } else if (Math.abs(px) > MAX_ABS_POSITION_M || Math.abs(py) > MAX_ABS_POSITION_M
          || Math.abs(pz) > MAX_ABS_POSITION_M) {
        // 防的是「有限但荒谬」的值：DB 是 DECIMAL(12,4)，1e9 这类值会先过校验、再在绑定参数时炸成 500。
        issues.add(issue("hotspot-invalid", "position 超出允许范围（±1,000 km）", id));
      }
      if (h.containsKey("normal") && !(h.get("normal") instanceof Map<?, ?>)) {
        issues.add(issue("hotspot-invalid", "normal 必须是对象", id));
      }
      final Map<String, Object> normal = mapOf(h.get("normal"));
      if (!normal.isEmpty()) {
        final Double nx = dbl(normal.get("x"));
        final Double ny = dbl(normal.get("y"));
        final Double nz = dbl(normal.get("z"));
        if (nx == null || ny == null || nz == null || !finite(nx) || !finite(ny) || !finite(nz)
            || Math.abs(Math.sqrt(nx * nx + ny * ny + nz * nz) - 1.0) > 0.05) {
          issues.add(issue("hotspot-invalid", "normal 必须是归一化向量（模长 1±0.05）", id));
        }
      }
      final String doorState = str(h.get("doorState")).isBlank() ? "any" : str(h.get("doorState"));
      if (!Set.of("any", "open", "closed").contains(doorState)) {
        issues.add(issue("hotspot-door-state-invalid", "doorState 只能是 any/open/closed", id));
      }
      if (h.containsKey("camera") && !(h.get("camera") instanceof Map<?, ?>)) {
        issues.add(issue("hotspot-camera-invalid", "camera 必须是对象", id));
      }
      final Map<String, Object> camera = mapOf(h.get("camera"));
      if (!camera.isEmpty() && !validCamera(camera)) {
        issues.add(issue("hotspot-camera-invalid", "camera 参数超出约定范围", id));
      }
      // actionKey 是热点→产品动作库的引用。库本身没有外键（替换顺序会死锁），
      // 所以「引用必须存在」只能在这一层守住：未知键必须 422，不能落库成悬空引用。
      final String actionKey = str(h.get("actionKey")).trim();
      if (!actionKey.isEmpty()) {
        if (actionKey.length() > MAX_ACTION_KEY) {
          issues.add(issue("hotspot-action-key-invalid",
              "第 " + (i + 1) + " 条 actionKey 超过 " + MAX_ACTION_KEY + " 字符", id));
        } else if (!ACTION_KEY_PATTERN.matcher(actionKey).matches()) {
          issues.add(issue("hotspot-action-key-invalid",
              "第 " + (i + 1) + " 条 actionKey 只能包含字母、数字、下划线、连字符", id));
        } else if (!allowedActionKeys.contains(actionKey)) {
          issues.add(issue("hotspot-action-unknown",
              "第 " + (i + 1) + " 条 actionKey 不在本产品动作库中：" + actionKey, id));
        }
      }
      final Map<String, Object> outH = new LinkedHashMap<>();
      outH.put("id", id);
      outH.put("modelId", modelId);
      outH.put("seq", i);
      outH.put("title", title);
      outH.put("body", body);
      outH.put("nodePath", path);
      outH.put("nodeIndex", nodeIndex);
      outH.put("nodeName", str(h.get("nodeName")));
      outH.put("position", Map.of("x", px == null ? 0 : px, "y", py == null ? 0 : py,
          "z", pz == null ? 0 : pz));
      if (!normal.isEmpty()) outH.put("normal", normal);
      outH.put("doorState", doorState);
      if (!camera.isEmpty()) outH.put("camera", camera);
      outH.put("actionKey", actionKey.isEmpty() ? null : actionKey);
      out.add(outH);
    }
    return out;
  }

  /**
   * 校验并规范化产品级动作库（V19）。形状：
   * {key,name,kind,target:{path:[..],index},motion:{axis,direction,angleDeg,pivotMm,distanceMm,visible,clipName,durationMs,toggle}}。
   *
   * 与热点校验同一套约定：攒 issues、一次 422、不写库。动作是产品级资源，
   * 所以 key 只需在产品内唯一（UNIQUE(product_id, action_key)）。
   */
  private List<Map<String, Object>> normalizeActions(Object raw, List<Map<String, Object>> issues) {
    if (!(raw instanceof List<?> list)) {
      issues.add(issue("action-invalid", "actions 必须是数组"));
      return List.of();
    }
    if (list.size() > MAX_ACTIONS) {
      issues.add(issue("action-too-many", "动作最多 " + MAX_ACTIONS + " 个，当前 " + list.size()));
    }
    final Set<String> keys = new LinkedHashSet<>();
    final List<Map<String, Object>> out = new ArrayList<>();
    for (int i = 0; i < list.size(); i++) {
      final int n = i + 1;
      if (!(list.get(i) instanceof Map<?, ?> rawMap)) {
        issues.add(issue("action-invalid", "第 " + n + " 个动作不是对象"));
        continue;
      }
      @SuppressWarnings("unchecked")
      final Map<String, Object> a = (Map<String, Object>) rawMap;
      final String key = str(a.get("key")).trim();
      if (key.isEmpty()) {
        issues.add(issue("action-invalid", "第 " + n + " 个动作 key 必填"));
      } else if (key.length() > MAX_ACTION_KEY) {
        issues.add(issue("action-invalid", "第 " + n + " 个动作 key 超过 " + MAX_ACTION_KEY + " 字符"));
      } else if (!ACTION_KEY_PATTERN.matcher(key).matches()) {
        issues.add(issue("action-invalid", "第 " + n + " 个动作 key 只能包含字母、数字、下划线、连字符"));
      } else if (!keys.add(key)) {
        issues.add(issue("action-duplicate-key", "动作 key 重复：" + key));
      }
      final String name = str(a.get("name")).trim();
      if (name.isEmpty() || name.length() > MAX_ACTION_NAME) {
        issues.add(issue("action-invalid", "第 " + n + " 个动作 name 必须 1~" + MAX_ACTION_NAME + " 字"));
      }
      final String kind = str(a.get("kind")).trim();
      if (!ACTION_KINDS.contains(kind)) {
        issues.add(issue("action-invalid", "第 " + n + " 个动作 kind 只能是 rotate/translate/visibility/clip"));
      }
      if (a.containsKey("target") && !(a.get("target") instanceof Map<?, ?>)) {
        issues.add(issue("action-target-invalid", "第 " + n + " 个动作 target 必须是对象"));
      }
      final Map<String, Object> target = mapOf(a.get("target"));
      final List<Object> path = listOf(target.get("path"));
      if (path.isEmpty()) {
        issues.add(issue("action-target-invalid", "第 " + n + " 个动作 target.path 必须是非空数组"));
      }
      if (path.size() > MAX_ACTION_PATH_DEPTH) {
        issues.add(issue("action-target-invalid",
            "第 " + n + " 个动作 target.path 最多 " + MAX_ACTION_PATH_DEPTH + " 层"));
      }
      final List<String> pathOut = new ArrayList<>();
      for (final Object seg : path) {
        final String s = str(seg);
        if (s.isBlank() || s.length() > MAX_ACTION_PATH_SEGMENT) {
          issues.add(issue("action-target-invalid", "第 " + n + " 个动作 target.path 每层必须非空且 ≤"
              + MAX_ACTION_PATH_SEGMENT + " 字符"));
          break;
        }
        pathOut.add(s);
      }
      final int index = (int) num(target.get("index"));
      if (index < 0 || index > 10000) {
        issues.add(issue("action-target-invalid", "第 " + n + " 个动作 target.index 必须在 0..10000"));
      }

      if (a.containsKey("motion") && !(a.get("motion") instanceof Map<?, ?>)) {
        issues.add(issue("action-motion-invalid", "第 " + n + " 个动作 motion 必须是对象"));
      }
      final Map<String, Object> motionIn = mapOf(a.get("motion"));
      final String axis = str(motionIn.get("axis")).trim();
      if (!axis.isEmpty() && !Set.of("x", "y", "z").contains(axis)) {
        issues.add(issue("action-motion-invalid", "第 " + n + " 个动作 motion.axis 只能是 x/y/z"));
      }
      String direction = str(motionIn.get("direction")).trim();
      if (!direction.isEmpty() && !Set.of("+", "-").contains(direction)) {
        issues.add(issue("action-motion-invalid", "第 " + n + " 个动作 motion.direction 只能是 + 或 -"));
      }
      final Double angle = dbl(motionIn.get("angleDeg"));
      final Double distance = dbl(motionIn.get("distanceMm"));
      final Double duration = dbl(motionIn.get("durationMs"));
      switch (kind) {
        case "rotate" -> {
          if (axis.isEmpty()) {
            issues.add(issue("action-motion-invalid", "第 " + n + " 个动作 rotate 需要 motion.axis"));
          }
          if (angle == null || !finite(angle) || angle == 0 || Math.abs(angle) > 360) {
            issues.add(issue("action-motion-invalid",
                "第 " + n + " 个动作 rotate 需要 motion.angleDeg（0 < |角度| ≤ 360）"));
          }
        }
        case "translate" -> {
          if (axis.isEmpty()) {
            issues.add(issue("action-motion-invalid", "第 " + n + " 个动作 translate 需要 motion.axis"));
          }
          if (distance == null || !finite(distance) || distance == 0) {
            issues.add(issue("action-motion-invalid",
                "第 " + n + " 个动作 translate 需要非零 motion.distanceMm"));
          }
        }
        case "visibility" -> {
          if (!(motionIn.get("visible") instanceof Boolean)) {
            issues.add(issue("action-motion-invalid", "第 " + n + " 个动作 visibility 需要布尔 motion.visible"));
          }
        }
        case "clip" -> {
          final String clipName = str(motionIn.get("clipName")).trim();
          if (clipName.isEmpty() || clipName.length() > MAX_ACTION_CLIP) {
            issues.add(issue("action-motion-invalid", "第 " + n + " 个动作 clip 需要 1~"
                + MAX_ACTION_CLIP + " 字符的 motion.clipName"));
          }
        }
        default -> {
          // kind 本身已经报错，这里不再叠第二条
        }
      }
      if (motionIn.containsKey("durationMs")) {
        if (duration == null || !finite(duration) || duration != Math.rint(duration)
            || duration < MIN_ACTION_DURATION_MS || duration > MAX_ACTION_DURATION_MS) {
          issues.add(issue("action-motion-invalid", "第 " + n + " 个动作 motion.durationMs 必须是 "
              + MIN_ACTION_DURATION_MS + ".." + MAX_ACTION_DURATION_MS + " 的整数"));
        }
      }
      if (motionIn.containsKey("toggle") && !(motionIn.get("toggle") instanceof Boolean)) {
        issues.add(issue("action-motion-invalid", "第 " + n + " 个动作 motion.toggle 必须是布尔"));
      }
      final List<Double> pivot = new ArrayList<>();
      if (motionIn.containsKey("pivotMm")) {
        final List<Object> rawPivot = listOf(motionIn.get("pivotMm"));
        boolean pivotOk = rawPivot.size() == 3;
        for (final Object c : rawPivot) {
          final Double v = dbl(c);
          if (v == null || !finite(v)) {
            pivotOk = false;
            break;
          }
          pivot.add(v);
        }
        if (!pivotOk) {
          issues.add(issue("action-motion-invalid", "第 " + n + " 个动作 motion.pivotMm 必须是三个有限数"));
        }
      }

      final Map<String, Object> motion = new LinkedHashMap<>();
      if (direction.isEmpty() && ("rotate".equals(kind) || "translate".equals(kind))) direction = "+";
      if (!axis.isEmpty()) motion.put("axis", axis);
      if (!direction.isEmpty()) motion.put("direction", direction);
      if (angle != null && finite(angle)) motion.put("angleDeg", angle);
      if (pivot.size() == 3) motion.put("pivotMm", pivot);
      if (distance != null && finite(distance)) motion.put("distanceMm", distance);
      if (motionIn.get("visible") instanceof Boolean visible) motion.put("visible", visible);
      final String clipName = str(motionIn.get("clipName")).trim();
      if (!clipName.isEmpty()) motion.put("clipName", clipName);
      if (duration != null && finite(duration)) motion.put("durationMs", duration.intValue());
      if (motionIn.get("toggle") instanceof Boolean toggle) motion.put("toggle", toggle);

      final Map<String, Object> outA = new LinkedHashMap<>();
      outA.put("key", key);
      outA.put("name", name);
      outA.put("kind", kind);
      final Map<String, Object> targetOut = new LinkedHashMap<>();
      targetOut.put("path", pathOut);
      targetOut.put("index", index);
      outA.put("target", targetOut);
      outA.put("motion", motion);
      out.add(outA);
    }
    return out;
  }

  /** 动作库里可被热点引用的键集合。兼容 DB 行（action_key）与已规范化对象（key）。 */
  private static Set<String> actionKeys(List<Map<String, Object>> actions) {
    final Set<String> out = new LinkedHashSet<>();
    for (final Map<String, Object> a : actions) {
      final String k = str(a.containsKey("key") ? a.get("key") : a.get("action_key")).trim();
      if (!k.isEmpty()) out.add(k);
    }
    return out;
  }

  /** DB 行 → API 形状；target_json/motion_json 坏数据退化成空对象，不 500。 */
  private List<Map<String, Object>> actionViews(List<Map<String, Object>> rows) {
    final List<Map<String, Object>> out = new ArrayList<>();
    for (final Map<String, Object> r : rows) {
      final Map<String, Object> a = new LinkedHashMap<>();
      a.put("key", str(r.get("action_key")));
      a.put("name", str(r.get("name")));
      a.put("kind", str(r.get("kind")));
      a.put("target", mapOf(parse(r.get("target_json"))));
      a.put("motion", mapOf(parse(r.get("motion_json"))));
      out.add(a);
    }
    return out;
  }

  private boolean validCamera(Map<String, Object> c) {
    final Double az = dbl(c.get("azimuthDeg"));
    final Double el = dbl(c.get("elevationDeg"));
    final Double dist = dbl(c.get("distFactor"));
    final Double fov = dbl(c.get("fov"));
    if (az == null || az < -180 || az > 180) return false;
    if (el == null || el < -89 || el > 89) return false;
    if (dist == null || dist < 0.5 || dist > 8) return false;
    if (fov != null && (fov < 20 || fov > 80)) return false;
    final List<Object> target = listOf(c.get("target"));
    if (target.size() != 3) return false;
    for (final Object t : target) {
      final Double v = dbl(t);
      if (v == null || v < 0 || v > 1) return false;
    }
    return true;
  }

  private void checkModelId(Map<String, Object> body, Map<String, Object> header,
                            List<Map<String, Object>> issues) {
    if (body == null || body.get("modelId") == null) return;
    final long wanted = num(body.get("modelId"));
    final long current = num(header.get("model_id"));
    if (wanted != current) {
      issues.add(issue("hotspot-model-invalid",
          "modelId 必须是该产品的 default 变体：" + current + "（收到 " + wanted + "）"));
    }
  }

  private List<String> stringList(Object raw, String field, int max, int maxLen,
                                  List<Map<String, Object>> issues) {
    if (!(raw instanceof List<?> list)) {
      issues.add(issue("content-selling-point-invalid", field + " 必须是数组"));
      return List.of();
    }
    if (list.size() > max) {
      issues.add(issue("content-selling-point-invalid", field + " 最多 " + max + " 条"));
    }
    final List<String> out = new ArrayList<>();
    for (final Object x : list) {
      final String s = str(x).trim();
      if (s.isEmpty()) {
        issues.add(issue("content-selling-point-invalid", "卖点不能为空"));
      } else if (s.length() > maxLen) {
        issues.add(issue("content-selling-point-invalid", "卖点超过 " + maxLen + " 字"));
      } else {
        out.add(s);
      }
    }
    return out;
  }

  private List<Map<String, Object>> paramList(Object raw, List<Map<String, Object>> issues) {
    if (!(raw instanceof List<?> list)) {
      issues.add(issue("content-param-invalid", "params 必须是数组"));
      return List.of();
    }
    if (list.size() > MAX_PARAMS) {
      issues.add(issue("content-param-invalid", "参数最多 " + MAX_PARAMS + " 条"));
    }
    final Set<String> keys = new LinkedHashSet<>();
    final List<Map<String, Object>> out = new ArrayList<>();
    for (final Object x : list) {
      if (!(x instanceof Map<?, ?> m)) {
        issues.add(issue("content-param-invalid", "参数不是对象"));
        continue;
      }
      final String key = str(m.get("key")).trim();
      final String value = str(m.get("value"));
      final String unit = str(m.get("unit")).trim();
      final String group = str(m.get("group")).trim();
      if (key.isEmpty() || key.length() > MAX_KEY) {
        issues.add(issue("content-param-invalid", "参数 key 必须非空且 ≤" + MAX_KEY + " 字"));
      } else if (!keys.add(key)) {
        issues.add(issue("content-param-duplicate-key", "参数 key 重复：" + key));
      }
      if (value.length() > MAX_VALUE) issues.add(issue("content-param-invalid", "参数 value 超过 " + MAX_VALUE + " 字"));
      if (unit.length() > MAX_UNIT) issues.add(issue("content-param-invalid", "参数 unit 超过 " + MAX_UNIT + " 字"));
      if (group.length() > MAX_GROUP) issues.add(issue("content-param-invalid", "参数 group 超过 " + MAX_GROUP + " 字"));
      final Map<String, Object> p = new LinkedHashMap<>();
      p.put("key", key);
      p.put("value", value);
      p.put("unit", unit);
      p.put("group", group);
      out.add(p);
    }
    return out;
  }

  private Map<String, Object> validationOf(Object raw, Map<String, Object> header) {
    final Map<String, Object> m = mapOf(raw);
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("checkedAt", str(m.get("checkedAt")).isBlank()
        ? DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(OffsetDateTime.now()) : str(m.get("checkedAt")));
    out.put("modelFingerprint", str(m.get("modelFingerprint")).isBlank()
        ? fingerprint(header) : str(m.get("modelFingerprint")));
    out.put("unit", str(m.get("unit")).isBlank() ? str(header.get("unit")) : str(m.get("unit")));
    final List<Map<String, Object>> invalid = new ArrayList<>();
    for (final Object x : listOf(m.get("invalid"))) {
      if (!(x instanceof Map<?, ?> im)) continue;
      final String reason = str(im.get("reason"));
      if (!REASONS.contains(reason)) continue;
      final Map<String, Object> inv = invalidReason(num(im.get("hotspotId")), reason,
          str(im.get("detail")));
      invalid.add(inv);
    }
    out.put("invalid", invalid);
    return out;
  }

  // ── 内部：快照/视图 ───────────────────────────────────────────────────

  private void ensureSnapshotFits(Map<String, Object> header, Draft draft,
                                   List<Map<String, Object>> hotspots,
                                   List<Map<String, Object>> actions, int rev, Object submitted) {
    final String snapshot = snapshotJson(header, draft, hotspots, actions, rev, submitted);
    if (utf8(snapshot) > MAX_SNAPSHOT_BYTES) {
      throw ApiProblem.contentInvalid(List.of(issue("content-too-large", "发布快照超过 256 KB")),
          "保存被拒：发布快照超过 256 KB");
    }
  }

  private String snapshotJson(Map<String, Object> header, Draft draft,
                              List<Map<String, Object>> hotspots, List<Map<String, Object>> actions,
                              int rev, Object submitted) {
    final Map<String, Object> validation = submitted == null ? draft.validation()
        : validationOf(submitted, header);
    final Map<String, Object> content = new LinkedHashMap<>();
    content.put("description", str(header.get("description")));
    content.put("sellingPoints", draft.sellingPoints());
    content.put("params", draft.params());
    final Map<String, Object> snap = new LinkedHashMap<>();
    snap.put("content", content);
    snap.put("hotspots", hotspots);
    snap.put("actions", actions == null ? List.of() : actions);
    snap.put("model", modelView(header));
    snap.put("validation", validation);
    snap.put("publishedRev", rev);
    snap.put("publishedAt", DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(OffsetDateTime.now()));
    return Json.write(snap, 0);
  }

  private Map<String, Object> legacyDetail(Map<String, Object> header) {
    final List<Map<String, Object>> notes = repo.notes(num(header.get("db_id")));
    final List<Map<String, Object>> params = new ArrayList<>();
    final List<String> selling = new ArrayList<>();
    for (final Map<String, Object> n : notes) {
      if ("fact".equals(str(n.get("kind")))) {
        final Map<String, Object> p = new LinkedHashMap<>();
        p.put("key", str(n.get("label")));
        p.put("value", str(n.get("value")));
        p.put("unit", "");
        p.put("group", "");
        params.add(p);
      } else if ("feature".equals(str(n.get("kind")))) {
        selling.add(str(n.get("label")) + "：" + str(n.get("value")));
      }
    }
    final Map<String, Object> content = new LinkedHashMap<>();
    content.put("description", str(header.get("description")));
    content.put("sellingPoints", selling);
    content.put("params", params);
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("catalogId", str(header.get("catalog_id")));
    out.put("modelNo", str(header.get("model_no")));
    out.put("name", str(header.get("name")));
    out.put("publishedRev", 0);
    out.put("publishedAt", null);
    out.put("unit", "m");
    out.put("coordSpace", "node-local");
    out.put("source", "legacy-projection");
    out.put("limits", Map.of("hotspots", MAX_HOTSPOTS, "actions", MAX_ACTIONS));
    out.put("model", modelView(header));
    out.put("content", content);
    out.put("actions", List.of());
    out.put("hotspots", List.of());
    out.put("counts", Map.of("total", 0, "valid", 0, "invalid", 0));
    out.put("invalidReasons", List.of());
    return out;
  }

  private Map<String, Object> adminModelView(Map<String, Object> header) {
    final Map<String, Object> m = new LinkedHashMap<>(modelView(header));
    m.put("id", m.get("modelId"));   // 维护端 105 §6.2 读的是 id；快照仍用 modelId
    return m;
  }

  private Map<String, Object> modelView(Map<String, Object> header) {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("modelId", num(header.get("model_id")));
    m.put("variant", str(header.get("variant")));
    m.put("file", str(header.get("file_path")));
    m.put("checksum", str(header.get("checksum")));
    m.put("unit", str(header.get("unit")));
    final Map<String, Object> bbox = new LinkedHashMap<>();
    bbox.put("w", dbl(header.get("bbox_w")));
    bbox.put("d", dbl(header.get("bbox_d")));
    bbox.put("h", dbl(header.get("bbox_h")));
    m.put("bboxMm", bbox);
    // 验收-1：内容接口也要给真实门/抽屉节点，形状与维护端卡片一致；坏 JSON → []
    m.put("hingeNodes", listOf(header.get("hinge_nodes")));
    // 声明包络（recipe_json 的 w/d/h）：编辑页回填用；recipe_json 坏/缺也返回三键对象，不 500
    m.put("declared", declaredOf(header));
    return m;
  }

  private Map<String, Object> declaredOf(Map<String, Object> header) {
    final Map<String, Object> recipe = mapOf(parse(header.get("recipe_json")));
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("w", dbl(recipe.get("w")));
    out.put("d", dbl(recipe.get("d")));
    out.put("h", dbl(recipe.get("h")));
    return out;
  }

  private List<Map<String, Object>> hotspotViews(List<Map<String, Object>> rows) {
    final List<Map<String, Object>> out = new ArrayList<>();
    for (final Map<String, Object> r : rows) {
      final Map<String, Object> h = new LinkedHashMap<>();
      h.put("id", num(r.get("id")));
      h.put("seq", (int) num(r.get("seq")));
      h.put("title", str(r.get("title")));
      h.put("body", str(r.get("body")));
      h.put("nodePath", listOf(parse(r.get("node_path"))));
      h.put("nodeIndex", (int) num(r.get("node_index")));
      h.put("nodeName", str(r.get("node_name")));
      final Map<String, Object> pos = new LinkedHashMap<>();
      pos.put("x", dbl(r.get("pos_x")));
      pos.put("y", dbl(r.get("pos_y")));
      pos.put("z", dbl(r.get("pos_z")));
      h.put("position", pos);
      if (r.get("nrm_x") != null || r.get("nrm_y") != null || r.get("nrm_z") != null) {
        final Map<String, Object> n = new LinkedHashMap<>();
        n.put("x", dbl(r.get("nrm_x")));
        n.put("y", dbl(r.get("nrm_y")));
        n.put("z", dbl(r.get("nrm_z")));
        h.put("normal", n);
      }
      h.put("doorState", str(r.get("door_state")).isBlank() ? "any" : str(r.get("door_state")));
      final Map<String, Object> cam = mapOf(parse(r.get("camera_json")));
      if (!cam.isEmpty()) h.put("camera", cam);
      final String actionKey = str(r.get("action_key")).trim();
      h.put("actionKey", actionKey.isEmpty() ? null : actionKey);
      out.add(h);
    }
    return out;
  }

  private Map<String, Object> savedResponse(int rev, List<Long> ids, int invalid,
                                            Map<String, Object> validation) {
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("rev", rev);
    out.put("published", false);
    out.put("hotspotIds", ids);
    out.put("invalidCount", invalid);
    out.put("warnings", warnings(validation));
    return out;
  }

  // ── 内部：审计/工具 ───────────────────────────────────────────────────

  private void auditSave(Map<String, Object> header, int rev, int selling, int params,
                         int hotspots, List<Long> ids, List<Map<String, Object>> existing,
                         int invalid, int actionCount, String actor) {
    final Set<Long> before = new LinkedHashSet<>();
    for (final Map<String, Object> h : existing) before.add(num(h.get("id")));
    final Set<Long> after = new LinkedHashSet<>(ids);
    final List<Long> added = new ArrayList<>();
    final List<Long> updated = new ArrayList<>();
    for (final Long id : ids) {
      if (before.contains(id)) updated.add(id); else added.add(id);
    }
    final List<Long> removed = new ArrayList<>();
    for (final Long id : before) if (!after.contains(id)) removed.add(id);
    final Map<String, Object> d = new LinkedHashMap<>();
    d.put("rev", rev);
    d.put("sellingCount", selling);
    d.put("paramCount", params);
    d.put("hotspotCount", hotspots);
    d.put("actionCount", actionCount);
    d.put("added", added);
    d.put("updated", updated);
    d.put("removed", removed);
    d.put("invalidCount", invalid);
    writeAudit(header, "product.content.save", d, actor);
  }

  private void auditPublish(Map<String, Object> header, int rev, int publishedRev, boolean ok, Draft draft,
                            Map<String, Object> validation, String snapshot, String error, String actor) {
    final Map<String, Object> d = new LinkedHashMap<>();
    d.put("rev", rev);
    d.put("publishedRev", publishedRev);
    d.put("published", ok);
    d.put("sellingCount", draft.sellingPoints().size());
    d.put("paramCount", draft.params().size());
    d.put("hotspotCount", mapList(mapOf(parse(snapshot)).get("hotspots")).size());
    d.put("actionCount", mapList(mapOf(parse(snapshot)).get("actions")).size());
    d.put("invalidCount", invalidCount(validation));
    d.put("publishedJsonSha256", sha256(snapshot));
    if (error != null) d.put("error", error);
    writeAudit(header, "product.content.publish", d, actor);
  }

  private void writeAudit(Map<String, Object> header, String action, Map<String, Object> detail, String actor) {
    try {
      audit.write(actor == null ? "" : actor, action, "product", str(header.get("model_no")),
          Json.write(detail, 0));
    } catch (RuntimeException e) {
      // 留痕失败不能吞：日志 ERROR，但业务结果已经落库，不回滚。
      log.error("[content] 审计写入失败 action={} model={}", action, header.get("model_no"), e);
    }
  }

  private Map<String, Object> headerOrThrow(long productId) {
    final Map<String, Object> h = repo.productHeader(productId);
    if (h == null) throw ApiProblem.productNotFound("产品不存在：" + productId);
    return h;
  }

  private int expectedRev(Map<String, Object> body, Map<String, Object> row) {
    final Object v = body == null ? null : body.get("expectedRev");
    return v == null ? revOf(row) : (int) num(v);
  }

  private Draft draftOf(Map<String, Object> row) {
    if (row == null) return new Draft(List.of(), List.of(), defaultValidation());
    final Map<String, Object> d = mapOf(parse(row.get("draft_json")));
    final List<String> selling = new ArrayList<>();
    for (final Object x : listOf(d.get("sellingPoints"))) selling.add(str(x));
    final List<Map<String, Object>> params = new ArrayList<>();
    for (final Object x : listOf(d.get("params"))) {
      if (x instanceof Map<?, ?> m) {
        final Map<String, Object> p = new LinkedHashMap<>();
        p.put("key", str(m.get("key")));
        p.put("value", str(m.get("value")));
        p.put("unit", str(m.get("unit")));
        p.put("group", str(m.get("group")));
        params.add(p);
      }
    }
    final Map<String, Object> validation = d.get("validation") instanceof Map<?, ?>
        ? mapOf(d.get("validation")) : defaultValidation();
    return new Draft(selling, params, validation);
  }

  private String draftJson(List<String> selling, List<Map<String, Object>> params,
                           Map<String, Object> validation) {
    final Map<String, Object> d = new LinkedHashMap<>();
    d.put("sellingPoints", selling);
    d.put("params", params);
    if (validation != null && !validation.isEmpty()) d.put("validation", validation);
    return Json.write(d, 0);
  }

  private Map<String, Object> defaultValidation() {
    final Map<String, Object> v = new LinkedHashMap<>();
    v.put("checkedAt", DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(OffsetDateTime.now()));
    v.put("modelFingerprint", "");
    v.put("unit", "");
    v.put("invalid", List.of());
    return v;
  }

  private Map<String, Object> publishedSummary(Map<String, Object> row) {
    if (row == null || publishedRevOf(row) == 0) return null;
    final Map<String, Object> snap = mapOf(parse(row.get("published_json")));
    final List<Map<String, Object>> hs = mapList(snap.get("hotspots"));
    final Map<String, Object> validation = mapOf(snap.get("validation"));
    final Set<Long> invalidIds = new LinkedHashSet<>();
    for (final Map<String, Object> inv : invalidList(validation)) invalidIds.add(num(inv.get("hotspotId")));
    final Map<String, Object> p = new LinkedHashMap<>();
    p.put("rev", publishedRevOf(row));
    p.put("at", publishedAtOf(row));
    final int invalidCount = Math.min(hs.size(), invalidIds.size());
    p.put("counts", Map.of("total", hs.size(), "valid", hs.size() - invalidCount,
        "invalid", invalidCount));
    return p;
  }

  private List<Map<String, Object>> warnings(Map<String, Object> validation) {
    final List<Map<String, Object>> out = new ArrayList<>();
    for (final Map<String, Object> inv : invalidList(validation)) {
      final Map<String, Object> w = new LinkedHashMap<>();
      w.put("level", "warn");
      w.put("code", "hotspot-" + str(inv.get("reason")));
      w.put("hotspotId", num(inv.get("hotspotId")));
      w.put("message", str(inv.get("detail")));
      out.add(w);
    }
    return out;
  }

  private List<Map<String, Object>> invalidList(Map<String, Object> validation) {
    final List<Map<String, Object>> out = new ArrayList<>();
    for (final Object x : listOf(validation.get("invalid"))) {
      if (x instanceof Map<?, ?> m) {
        final Map<String, Object> inv = new LinkedHashMap<>();
        inv.put("hotspotId", num(m.get("hotspotId")));
        inv.put("reason", str(m.get("reason")));
        inv.put("detail", str(m.get("detail")));
        out.add(inv);
      }
    }
    return out;
  }

  private Map<String, Object> invalidReason(long id, String reason, String detail) {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("hotspotId", id);
    m.put("reason", reason);
    m.put("detail", detail);
    return m;
  }

  private int invalidCount(Map<String, Object> validation) {
    return invalidList(validation).size();
  }

  private String fingerprint(Map<String, Object> header) {
    final String variant = str(header.get("variant"));
    final String checksum = str(header.get("checksum"));
    return variant.isBlank() || checksum.isBlank() ? "" : variant + ":" + checksum;
  }

  private String etag(Map<String, Object> header, int rev, String kind) {
    // 设计决策记录的 ETag 口径：W/"<modelNo>-<publishedRev>"；kind 只用于内部区分，不进头
    final String model = str(header.get("model_no")).replace("\"", "");
    return "W/\"" + model + "-" + rev + "\"";
  }

  private static Map<String, Object> issue(String code, String message) {
    return issue(code, message, 0);
  }

  private static Map<String, Object> issue(String code, String message, long hotspotId) {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("level", "bad");
    m.put("code", code);
    m.put("message", message);
    if (hotspotId > 0) m.put("hotspotId", hotspotId);
    return m;
  }

  static int revOf(Map<String, Object> row) {
    return row == null ? 0 : (int) num(row.get("rev"));
  }

  static int publishedRevOf(Map<String, Object> row) {
    return row == null ? 0 : (int) num(row.get("published_rev"));
  }

  static String publishedAtOf(Map<String, Object> row) {
    if (row == null) return null;
    final Object v = row.get("published_at");
    if (v == null) return null;
    if (v instanceof java.sql.Timestamp ts) {
      return OffsetDateTime.ofInstant(ts.toInstant(), java.time.ZoneId.systemDefault())
          .format(DateTimeFormatter.ISO_OFFSET_DATE_TIME);
    }
    if (v instanceof java.time.LocalDateTime ldt) {
      return ldt.atZone(java.time.ZoneId.systemDefault()).toOffsetDateTime()
          .format(DateTimeFormatter.ISO_OFFSET_DATE_TIME);
    }
    return str(v);
  }

  static long num(Object o) {
    if (o instanceof Number n) return n.longValue();
    if (o == null) return 0;
    try {
      return Long.parseLong(String.valueOf(o).trim());
    } catch (NumberFormatException e) {
      return 0;
    }
  }

  static String str(Object o) {
    return o == null ? "" : String.valueOf(o);
  }

  static Double dbl(Object o) {
    if (o instanceof Number n) return n.doubleValue();
    if (o == null) return null;
    try {
      return Double.parseDouble(String.valueOf(o).trim());
    } catch (NumberFormatException e) {
      return null;
    }
  }

  static boolean finite(double d) {
    return Double.isFinite(d);
  }

  static Map<String, Object> mapOf(Object o) {
    if (o instanceof Map<?, ?> m) {
      final Map<String, Object> out = new LinkedHashMap<>();
      for (final Map.Entry<?, ?> e : m.entrySet()) out.put(String.valueOf(e.getKey()), e.getValue());
      return out;
    }
    if (o instanceof String s && !s.isBlank()) {
      final Object parsed = parse(s);
      return parsed instanceof Map<?, ?> ? mapOf(parsed) : Map.of();
    }
    return Map.of();
  }

  static List<Map<String, Object>> mapList(Object o) {
    final List<Map<String, Object>> out = new ArrayList<>();
    for (final Object x : listOf(o)) {
      if (x instanceof Map<?, ?> m) out.add(mapOf(m));
    }
    return out;
  }

  static List<Object> listOf(Object o) {
    if (o instanceof List<?> l) return new ArrayList<>(l);
    if (o instanceof String s && !s.isBlank()) {
      final Object parsed = parse(s);
      return parsed instanceof List<?> l ? new ArrayList<>(l) : List.of();
    }
    return List.of();
  }

  static Object parse(Object o) {
    if (o == null) return null;
    if (o instanceof String s) {
      if (s.isBlank() || "null".equals(s)) return null;
      try {
        return Json.parse(s);
      } catch (RuntimeException e) {
        return null;
      }
    }
    return o;
  }

  static int utf8(String s) {
    return s == null ? 0 : s.getBytes(StandardCharsets.UTF_8).length;
  }

  static String sha256(String s) {
    try {
      final MessageDigest md = MessageDigest.getInstance("SHA-256");
      return HexFormat.of().formatHex(md.digest((s == null ? "" : s).getBytes(StandardCharsets.UTF_8)));
    } catch (Exception e) {
      return "";
    }
  }

  record Draft(List<String> sellingPoints, List<Map<String, Object>> params,
               Map<String, Object> validation) {}

  public record Detail(Map<String, Object> body, String etag) {}

  record PublishOutcome(boolean published, int publishedRev, String publishedAt,
                        Map<String, Object> validation, String errorCode, String errorMessage) {
    static PublishOutcome failed(String code, String message, int oldRev, Map<String, Object> validation) {
      return new PublishOutcome(false, oldRev, null, validation, code, message);
    }

    Map<String, Object> body() {
      final Map<String, Object> out = new LinkedHashMap<>();
      out.put("published", published);
      out.put("publishedRev", publishedRev);
      if (publishedAt != null) out.put("publishedAt", publishedAt);
      if (!published) {
        out.put("publishError", Map.of("code", errorCode == null ? "publish-failed" : errorCode,
            "message", errorMessage == null ? "发布步骤失败" : errorMessage));
      }
      return out;
    }
  }
}
