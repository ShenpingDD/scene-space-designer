package com.scene.spatial.admin;

import com.scene.spatial.api.ApiProblem;
import com.scene.spatial.kernel.Json;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.Mockito;
import org.mockito.invocation.Invocation;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * ProductActionServiceTest —— V19 产品级动作库（不依赖真库）。
 *
 * 判的是四件容易静默错的事：
 *   ① 动作库只在「传了 actions」时整体替换，没传必须保留（旧客户端兼容）；
 *   ② 热点 actionKey 必须存在于本次/现有动作库，未知键 422 而不是落库成悬空引用；
 *   ③ 发布快照内嵌 actions，公开 detail 能读回，旧快照仍返回 actions=[]、actionKey=null；
 *   ④ 审计 save/publish 都带 actionCount。
 * 真库往返（含「替换动作库后旧热点引用被清空」）见 ProductActionJdbcTest。
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ProductActionServiceTest {

  @Mock
  private ProductContentRepository repo;

  @Mock
  private AuditLog audit;

  private ProductContentService service;
  private Map<String, Object> header;
  private AtomicReference<Map<String, Object>> row;
  private AtomicReference<List<Map<String, Object>>> dbActions;
  private AtomicReference<List<Map<String, Object>>> dbHotspots;
  private AtomicReference<List<Map<String, Object>>> savedActions;
  private AtomicReference<List<Map<String, Object>>> savedHotspots;
  private AtomicReference<String> publishedJson;

  @BeforeEach
  void setUp() {
    service = new ProductContentService(repo, audit);
    header = new LinkedHashMap<>();
    header.put("db_id", 1L);
    header.put("model_no", "DEMO-ACT");
    header.put("name", "动作测试产品");
    header.put("status", "active");
    header.put("description", "产品简介");
    header.put("catalog_id", "dw-act");
    header.put("model_id", 9L);
    header.put("variant", "default");
    header.put("file_path", "assets/optimized/act.lod0.glb");
    header.put("checksum", "abc123");
    header.put("unit", "mm");
    header.put("bbox_w", 990);
    header.put("bbox_d", 871);
    header.put("bbox_h", 1980);
    header.put("recipe_json", "{\"id\":\"dw-act\",\"unit\":\"mm\",\"w\":990,\"d\":871,\"h\":1980}");
    row = new AtomicReference<>();
    dbActions = new AtomicReference<>(List.of());
    dbHotspots = new AtomicReference<>(List.of());
    savedActions = new AtomicReference<>();
    savedHotspots = new AtomicReference<>(List.of());
    publishedJson = new AtomicReference<>();

    when(repo.productHeader(1L)).thenReturn(header);
    when(repo.productByCatalogId("dw-act")).thenReturn(header);
    when(repo.contentRow(1L)).thenAnswer(inv -> row.get());
    when(repo.actions(1L)).thenAnswer(inv -> dbActions.get());
    when(repo.hotspots(1L)).thenAnswer(inv -> dbHotspots.get());
    when(repo.saveDraft(anyLong(), anyString(), any(), anyInt(), anyString())).thenAnswer(inv -> {
      final int expected = inv.getArgument(3);
      if (expected != ProductContentService.revOf(row.get())) return false;
      if (inv.getArgument(2) != null) savedActions.set(inv.getArgument(2));
      final Map<String, Object> next = nextRow();
      next.put("rev", expected + 1);
      next.put("draft_json", inv.getArgument(1));
      row.set(next);
      return true;
    });
    when(repo.saveHotspots(anyLong(), anyString(), any(), any(), anyInt(), anyString()))
        .thenAnswer(inv -> {
          final int expected = inv.getArgument(4);
          if (expected != ProductContentService.revOf(row.get())) return null;
          if (inv.getArgument(3) != null) savedActions.set(inv.getArgument(3));
          savedHotspots.set(inv.getArgument(2));
          final Map<String, Object> next = nextRow();
          next.put("rev", expected + 1);
          row.set(next);
          return List.of(101L);
        });
    when(repo.saveContentAndHotspots(anyLong(), anyString(), any(), any(), anyInt(), anyString()))
        .thenAnswer(inv -> {
          final int expected = inv.getArgument(4);
          if (expected != ProductContentService.revOf(row.get())) return null;
          if (inv.getArgument(3) != null) savedActions.set(inv.getArgument(3));
          savedHotspots.set(inv.getArgument(2));
          dbActions.set(List.of(dbAction("door-open", "rotate",
              "{\"axis\":\"y\",\"angleDeg\":105,\"direction\":\"+\"}")));
          dbHotspots.set(List.of(dbHotspot(101L, "门内托盘", "door-open")));
          final Map<String, Object> next = nextRow();
          next.put("rev", expected + 1);
          next.put("draft_json", inv.getArgument(1));
          row.set(next);
          return List.of(101L);
        });
    when(repo.publish(anyLong(), anyString(), anyInt(), anyString())).thenAnswer(inv -> {
      final int rev = inv.getArgument(2);
      if (rev != ProductContentService.revOf(row.get())) return false;
      publishedJson.set(inv.getArgument(1));
      final Map<String, Object> next = nextRow();
      next.put("published_rev", rev);
      next.put("published_json", inv.getArgument(1));
      next.put("published_at", "2026-11-23T22:00:00+08:00");
      row.set(next);
      return true;
    });
  }

  // ── 动作库写入 ───────────────────────────────────────────────────────

  @Test
  @DisplayName("传 actions：整体替换；direction 缺省归一为 +，durationMs/toggle 原样保留")
  void actionsAreNormalizedAndReplaced() {
    row.set(emptyRow(0));
    final Map<String, Object> a = action("door-open", "rotate",
        motion("axis", "y", "angleDeg", 105, "pivotMm", List.of(287.71, 70, 363),
            "durationMs", 900, "toggle", true));

    service.saveContent(1L, Map.of("sellingPoints", List.of(), "params", List.of(),
        "actions", List.of(a), "expectedRev", 0), "tester");

    final List<Map<String, Object>> stored = savedActions.get();
    assertNotNull(stored, "传了 actions 就必须把动作库交给 repository 整体替换");
    assertEquals(1, stored.size());
    final Map<String, Object> got = stored.get(0);
    assertEquals("door-open", got.get("key"));
    assertEquals("开门", got.get("name"));
    assertEquals("rotate", got.get("kind"));
    assertEquals(List.of("root", "door"), ((Map<?, ?>) got.get("target")).get("path"));
    assertEquals(0, ((Map<?, ?>) got.get("target")).get("index"));
    final Map<?, ?> m = (Map<?, ?>) got.get("motion");
    assertEquals("y", m.get("axis"));
    assertEquals("+", m.get("direction"), "rotate 没给 direction 时归一为 +，快照里不留歧义");
    assertEquals(105.0, m.get("angleDeg"));
    assertEquals(List.of(287.71, 70.0, 363.0), m.get("pivotMm"));
    assertEquals(900, m.get("durationMs"));
    assertEquals(true, m.get("toggle"));
  }

  @Test
  @DisplayName("不传 actions：保留现有动作库（repository 收到 null），旧客户端兼容")
  void omittingActionsKeepsLibrary() {
    row.set(emptyRow(0));
    dbActions.set(List.of(dbAction("door-open", "rotate", "{\"axis\":\"y\",\"angleDeg\":105}")));

    service.saveContent(1L, Map.of("sellingPoints", List.of(), "params", List.of(),
        "expectedRev", 0), "tester");

    assertNull(savedActions.get(), "没传 actions 时不许清空动作库");
    verify(repo).saveDraft(eq(1L), anyString(), isNull(), eq(0), anyString());
  }

  @Test
  @DisplayName("rotate 缺 angleDeg：422 content-invalid，不写库")
  void rotateWithoutAngleIsRejected() {
    row.set(emptyRow(0));
    final ApiProblem p = assertThrows(ApiProblem.class, () -> service.saveContent(1L, Map.of(
        "sellingPoints", List.of(), "params", List.of(),
        "actions", List.of(action("bad-rotate", "rotate", motion("axis", "y"))),
        "expectedRev", 0), "tester"));
    assertEquals(422, p.status());
    assertEquals("content-invalid", p.extra().get("code"));
    assertTrue(codes(p).contains("action-motion-invalid"));
    verify(repo, never()).saveDraft(anyLong(), anyString(), any(), anyInt(), anyString());
  }

  @Test
  @DisplayName("动作 key 重复 / kind 越界：422，且不写库")
  void duplicateKeyAndUnknownKindAreRejected() {
    row.set(emptyRow(0));
    final Map<String, Object> rotate = action("door-open", "rotate", motion("axis", "y", "angleDeg", 105));
    final ApiProblem dup = assertThrows(ApiProblem.class, () -> service.saveContent(1L, Map.of(
        "actions", List.of(rotate, rotate), "expectedRev", 0), "tester"));
    assertEquals(422, dup.status());
    assertTrue(codes(dup).contains("action-duplicate-key"));

    final ApiProblem kind = assertThrows(ApiProblem.class, () -> service.saveContent(1L, Map.of(
        "actions", List.of(action("fly", "fly", motion("axis", "y"))), "expectedRev", 0), "tester"));
    assertEquals(422, kind.status());
    assertTrue(codes(kind).contains("action-invalid"));
    verify(repo, never()).saveContentAndHotspots(anyLong(), anyString(), any(), any(), anyInt(), anyString());
    verify(repo, never()).saveDraft(anyLong(), anyString(), any(), anyInt(), anyString());
  }

  @Test
  @DisplayName("⭐ 大写 action key：422（身份口径是小写，不悄悄改写）")
  void uppercaseActionKeyIsRejected() {
    row.set(emptyRow(0));
    final ApiProblem p = assertThrows(ApiProblem.class, () -> service.saveContent(1L, Map.of(
        "actions", List.of(action("Door-Open", "rotate", motion("axis", "y", "angleDeg", 105))),
        "expectedRev", 0), "tester"));
    assertEquals(422, p.status(), "key 会进唯一键与快照，大小写混用等于两个身份");
    assertTrue(codes(p).contains("action-invalid"), "实际 issues：" + codes(p));
    verify(repo, never()).saveDraft(anyLong(), anyString(), any(), anyInt(), anyString());
    verify(repo, never()).saveContentAndHotspots(anyLong(), anyString(), any(), any(), anyInt(), anyString());
  }

  // ── 热点引用 ─────────────────────────────────────────────────────────

  @Test
  @DisplayName("未知 actionKey：422 hotspot-action-unknown，热点不写")
  void unknownHotspotActionKeyIsRejected() {
    row.set(emptyRow(0));
    dbActions.set(List.of(dbAction("door-open", "rotate", "{\"axis\":\"y\",\"angleDeg\":105}")));

    final ApiProblem p = assertThrows(ApiProblem.class, () -> service.saveHotspots(1L, Map.of(
        "hotspots", List.of(hotspot("门内托盘", "drawer-open")), "expectedRev", 0), "tester"));

    assertEquals(422, p.status());
    assertTrue(codes(p).contains("hotspot-action-unknown"));
    verify(repo, never()).saveHotspots(anyLong(), anyString(), any(), any(), anyInt(), anyString());
  }

  @Test
  @DisplayName("actionKey 格式非法（含空格）：422 hotspot-action-key-invalid")
  void malformedHotspotActionKeyIsRejected() {
    row.set(emptyRow(0));
    dbActions.set(List.of(dbAction("door open", "rotate", "{}")));

    final ApiProblem p = assertThrows(ApiProblem.class, () -> service.saveHotspots(1L, Map.of(
        "hotspots", List.of(hotspot("门内托盘", "door open")), "expectedRev", 0), "tester"));

    assertEquals(422, p.status());
    assertTrue(codes(p).contains("hotspot-action-key-invalid"));
  }

  @Test
  @DisplayName("本次提交的动作库可被同请求热点引用；快照与审计都带 actions")
  void combinedSaveCarriesActionsIntoSnapshotAndAudit() {
    row.set(emptyRow(0));
    final Map<String, Object> a = action("door-open", "rotate",
        motion("axis", "y", "angleDeg", 105, "direction", "+"));
    final Map<String, Object> out = service.saveContent(1L, Map.of(
        "sellingPoints", List.of(), "params", List.of(),
        "actions", List.of(a), "hotspots", List.of(hotspot("门内托盘", "door-open")),
        "expectedRev", 0), "tester");

    assertEquals(true, out.get("published"), String.valueOf(out));
    assertEquals(1, savedActions.get().size());
    assertEquals("door-open", ((Map<?, ?>) savedHotspots.get().get(0)).get("actionKey"));
    assertTrue(publishedJson.get().contains("\"actions\""), "发布快照必须内嵌动作库");
    assertTrue(publishedJson.get().contains("\"door-open\""));
    assertEquals(1, auditDetail("product.content.save").get("actionCount"));
    assertEquals(1, auditDetail("product.content.publish").get("actionCount"));
  }

  @Test
  @DisplayName("替换动作库后旧热点引用仍指向旧 key：422（拒绝，不静默清空）")
  void replacingLibraryRejectsOldHotspotReference() {
    row.set(emptyRow(0));
    dbActions.set(List.of(dbAction("door-open", "rotate", "{\"axis\":\"y\",\"angleDeg\":105}")));
    final Map<String, Object> drawer = action("drawer-open", "translate",
        motion("axis", "z", "distanceMm", 450));

    final ApiProblem p = assertThrows(ApiProblem.class, () -> service.saveContent(1L, Map.of(
        "actions", List.of(drawer),
        "hotspots", List.of(hotspot("门内托盘", "door-open")),
        "expectedRev", 0), "tester"));

    assertEquals(422, p.status());
    assertTrue(codes(p).contains("hotspot-action-unknown"),
        "热点不能引用已被替换掉的动作 key");
    verify(repo, never()).saveContentAndHotspots(anyLong(), anyString(), any(), any(), anyInt(), anyString());
  }

  // ── 读取/发布 ────────────────────────────────────────────────────────

  @Test
  @DisplayName("维护端 content：actions 回 camelCase；热点 actionKey 无则 null 但键存在")
  void adminContentReturnsActionsAndHotspotActionKey() {
    row.set(emptyRow(0));
    dbActions.set(List.of(dbAction("door-open", "rotate",
        "{\"axis\":\"y\",\"angleDeg\":105,\"direction\":\"+\"}")));
    dbHotspots.set(List.of(dbHotspot(7L, "门内托盘", "door-open"), dbHotspot(8L, "铭牌", null)));

    final Map<String, Object> out = service.adminContent(1L);

    final List<?> actions = (List<?>) out.get("actions");
    assertEquals(1, actions.size());
    final Map<?, ?> a = (Map<?, ?>) actions.get(0);
    assertEquals("door-open", a.get("key"));
    assertEquals("开门", a.get("name"));
    assertEquals("rotate", a.get("kind"));
    assertEquals(List.of("root", "door"), ((Map<?, ?>) a.get("target")).get("path"));
    assertEquals(0, ((Map<?, ?>) a.get("target")).get("index"));
    assertEquals(105, ((Number) ((Map<?, ?>) a.get("motion")).get("angleDeg")).intValue());

    final List<?> hs = (List<?>) out.get("hotspots");
    assertEquals("door-open", ((Map<?, ?>) hs.get(0)).get("actionKey"));
    assertTrue(((Map<?, ?>) hs.get(1)).containsKey("actionKey"), "无绑定时也要有键");
    assertNull(((Map<?, ?>) hs.get(1)).get("actionKey"));
  }

  @Test
  @DisplayName("发布：快照内嵌当前动作库，公开 detail 读回 actions 与热点 actionKey")
  void publishSnapshotCarriesActionsIntoDetail() {
    row.set(rowWithPublished(2, 1, publishedSnapshot(true)));
    dbActions.set(List.of(dbAction("door-open", "rotate",
        "{\"axis\":\"y\",\"angleDeg\":105,\"direction\":\"+\"}")));
    dbHotspots.set(List.of(dbHotspot(7L, "门内托盘", "door-open")));

    final Map<String, Object> pub = service.publish(1L, Map.of("expectedRev", 2), "tester");
    assertEquals(true, pub.get("published"));
    assertTrue(publishedJson.get().contains("\"door-open\""));
    assertEquals(1, auditDetail("product.content.publish").get("actionCount"));

    final ProductContentService.Detail d = service.detail("dw-act");
    final List<?> actions = (List<?>) d.body().get("actions");
    assertEquals(1, actions.size());
    assertEquals("door-open", ((Map<?, ?>) actions.get(0)).get("key"));
    final List<?> hs = (List<?>) d.body().get("hotspots");
    assertEquals(1, hs.size());
    assertEquals("door-open", ((Map<?, ?>) hs.get(0)).get("actionKey"));
  }

  @Test
  @DisplayName("旧快照无 actions / 无 actionKey：detail 返回 [] 与 null，不 404/500")
  void legacySnapshotWithoutActionsStaysCompatible() {
    row.set(rowWithPublished(3, 3, publishedSnapshot(false)));

    final ProductContentService.Detail d = service.detail("dw-act");

    assertEquals("published", d.body().get("source"));
    assertEquals(List.of(), d.body().get("actions"), "旧快照必须退化成空动作库");
    final List<?> hs = (List<?>) d.body().get("hotspots");
    assertEquals(1, hs.size());
    assertTrue(((Map<?, ?>) hs.get(0)).containsKey("actionKey"));
    assertNull(((Map<?, ?>) hs.get(0)).get("actionKey"));
  }

  @Test
  @DisplayName("老产品（无 product_content）：detail 的 actions 也是空数组")
  void legacyProductHasEmptyActions() {
    row.set(null);
    final ProductContentService.Detail d = service.detail("dw-act");
    assertEquals("legacy-projection", d.body().get("source"));
    assertEquals(List.of(), d.body().get("actions"));
    assertFalse(((List<?>) d.body().get("hotspots")).iterator().hasNext());
  }

  // ── 夹具 ─────────────────────────────────────────────────────────────

  private static Map<String, Object> emptyRow(int rev) {
    final Map<String, Object> r = new LinkedHashMap<>();
    r.put("rev", rev);
    r.put("published_rev", 0);
    r.put("draft_json", Json.write(Map.of("sellingPoints", List.of(), "params", List.of()), 0));
    return r;
  }

  private static Map<String, Object> rowWithPublished(int rev, int publishedRev, String snapshot) {
    final Map<String, Object> r = emptyRow(rev);
    r.put("published_rev", publishedRev);
    r.put("published_json", snapshot);
    r.put("published_at", "2026-11-23T22:00:00+08:00");
    return r;
  }

  private Map<String, Object> nextRow() {
    final Map<String, Object> cur = row.get();
    return cur == null ? new LinkedHashMap<>() : new LinkedHashMap<>(cur);
  }

  private static Map<String, Object> action(String key, String kind, Map<String, Object> motion) {
    final Map<String, Object> a = new LinkedHashMap<>();
    a.put("key", key);
    a.put("name", "开门");
    a.put("kind", kind);
    a.put("target", Map.of("path", List.of("root", "door"), "index", 0));
    a.put("motion", motion);
    return a;
  }

  private static Map<String, Object> motion(Object... kv) {
    final Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i + 1 < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
    return m;
  }

  private static Map<String, Object> hotspot(String title, String actionKey) {
    final Map<String, Object> h = new LinkedHashMap<>();
    h.put("title", title);
    h.put("body", "说明");
    h.put("nodePath", List.of("root", "door"));
    h.put("nodeIndex", 0);
    h.put("position", Map.of("x", 0.1, "y", 0.5, "z", 0.2));
    h.put("doorState", "open");
    if (actionKey != null) h.put("actionKey", actionKey);
    return h;
  }

  /** DB 行的形状（snake_case + JSON 字符串列），用来验证 actionViews/hotspotViews 的映射。 */
  private static Map<String, Object> dbAction(String key, String kind, String motionJson) {
    final Map<String, Object> a = new LinkedHashMap<>();
    a.put("action_key", key);
    a.put("name", "开门");
    a.put("kind", kind);
    a.put("target_json", "{\"path\":[\"root\",\"door\"],\"index\":0}");
    a.put("motion_json", motionJson);
    a.put("sort_order", 0);
    return a;
  }

  private static Map<String, Object> dbHotspot(long id, String title, String actionKey) {
    final Map<String, Object> h = new LinkedHashMap<>();
    h.put("id", id);
    h.put("seq", 0);
    h.put("title", title);
    h.put("body", "说明");
    h.put("node_path", "[\"root\",\"door\"]");
    h.put("node_index", 0);
    h.put("node_name", "door");
    h.put("pos_x", 0.1);
    h.put("pos_y", 0.5);
    h.put("pos_z", 0.2);
    h.put("door_state", "open");
    h.put("action_key", actionKey);
    return h;
  }

  /** 已发布快照的两种形状：V19（带 actions + actionKey）与 V18（都不带）。 */
  private static String publishedSnapshot(boolean withActions) {
    final Map<String, Object> content = new LinkedHashMap<>();
    content.put("description", "产品简介");
    content.put("sellingPoints", List.of());
    content.put("params", List.of());
    final Map<String, Object> h = new LinkedHashMap<>();
    h.put("id", 7L);
    h.put("seq", 0);
    h.put("title", "门内托盘");
    h.put("body", "说明");
    h.put("nodePath", List.of("root", "door"));
    h.put("nodeIndex", 0);
    h.put("nodeName", "door");
    h.put("position", Map.of("x", 0.1, "y", 0.5, "z", 0.2));
    h.put("doorState", "open");
    if (withActions) h.put("actionKey", "door-open");
    final Map<String, Object> snap = new LinkedHashMap<>();
    snap.put("content", content);
    snap.put("hotspots", List.of(h));
    if (withActions) {
      final Map<String, Object> a = new LinkedHashMap<>();
      a.put("key", "door-open");
      a.put("name", "开门");
      a.put("kind", "rotate");
      a.put("target", Map.of("path", List.of("root", "door"), "index", 0));
      a.put("motion", Map.of("axis", "y", "angleDeg", 105, "direction", "+"));
      snap.put("actions", List.of(a));
    }
    snap.put("model", Map.of("modelId", 9));
    snap.put("validation", Map.of("checkedAt", "2026-11-23T22:00:00+08:00",
        "modelFingerprint", "default:abc123", "unit", "mm", "invalid", List.of()));
    snap.put("publishedRev", 3);
    snap.put("publishedAt", "2026-11-23T22:00:00+08:00");
    return Json.write(snap, 0);
  }

  private static List<String> codes(ApiProblem p) {
    final List<String> out = new ArrayList<>();
    final Object issues = p.extra() == null ? null : p.extra().get("issues");
    if (issues instanceof List<?> list) {
      for (final Object x : list) {
        if (x instanceof Map<?, ?> m) out.add(String.valueOf(m.get("code")));
      }
    }
    return out;
  }

  /** 审计里某个 action 的 detail（Json.write 的产物），解析回 Map 供断言。 */
  private Map<String, Object> auditDetail(String action) {
    for (final Invocation inv : Mockito.mockingDetails(audit).getInvocations()) {
      if ("write".equals(inv.getMethod().getName()) && action.equals(inv.getArgument(1))) {
        final Object parsed = Json.parse((String) inv.getArgument(4));
        return parsed instanceof Map<?, ?> m ? ProductContentService.mapOf(m) : Map.of();
      }
    }
    return Map.of();
  }
}
