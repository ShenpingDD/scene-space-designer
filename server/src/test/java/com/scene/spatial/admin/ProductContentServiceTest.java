package com.scene.spatial.admin;

import com.scene.spatial.api.ApiProblem;
import com.scene.spatial.kernel.Json;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
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
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * ProductContentServiceTest —— 设计决策记录的 P0 判据（不依赖真库）。
 *
 * 为什么用替身：这批要判的是**编排与失败隔离**（422 不写、409 不写、发布失败旧快照保留、
 * 老产品投影），这些结论由 service 的纯逻辑决定；真库留给端到端探针。
 * 替身只替 repository 的行，不替校验规则 —— 规则在 service 里。
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ProductContentServiceTest {

  @Mock
  private ProductContentRepository repo;

  @Mock
  private AuditLog audit;

  private ProductContentService service;
  private Map<String, Object> header;
  private AtomicReference<Map<String, Object>> row;
  private AtomicReference<List<Map<String, Object>>> actionRows;

  @BeforeEach
  void setUp() {
    service = new ProductContentService(repo, audit);
    header = new LinkedHashMap<>();
    header.put("db_id", 1L);
    header.put("model_no", "DEMO-TEST");
    header.put("name", "测试产品");
    header.put("status", "active");
    header.put("description", "产品简介");
    header.put("catalog_id", "dw-test");
    header.put("model_id", 9L);
    header.put("variant", "default");
    header.put("file_path", "assets/optimized/test.lod0.glb");
    header.put("checksum", "abc123");
    header.put("unit", "mm");
    header.put("bbox_w", 990);
    header.put("bbox_d", 871);
    header.put("bbox_h", 1980);
    header.put("recipe_json", "{\"id\":\"dw-test\",\"unit\":\"mm\",\"w\":990,\"d\":871,\"h\":1980}");
    row = new AtomicReference<>();
    actionRows = new AtomicReference<>(List.of());
    when(repo.productHeader(1L)).thenReturn(header);
    when(repo.contentRow(1L)).thenAnswer(inv -> row.get());
    when(repo.hotspots(1L)).thenReturn(List.of());
    when(repo.actions(1L)).thenAnswer(inv -> actionRows.get());
    when(repo.notes(1L)).thenReturn(List.of());
  }

  @Test
  @DisplayName("content 接口的 model.hingeNodes 与 header 一致；坏 JSON 给空数组")
  void contentModelCarriesHingeNodes() {
    header.put("hinge_nodes", "[{\"node\":\"door\",\"axis\":\"y\",\"openAngleDeg\":106}]");
    final Map<String, Object> out = service.adminContent(1L);
    final Map<?, ?> model = (Map<?, ?>) out.get("model");
    assertTrue(model.get("hingeNodes") instanceof List);
    final List<?> nodes = (List<?>) model.get("hingeNodes");
    assertEquals(1, nodes.size());
    assertEquals("door", ((Map<?, ?>) nodes.get(0)).get("node"));
    assertEquals(106, ((Map<?, ?>) nodes.get(0)).get("openAngleDeg"));

    header.put("hinge_nodes", "not-json");
    final Map<String, Object> broken = service.adminContent(1L);
    assertEquals(List.of(), ((Map<?, ?>) broken.get("model")).get("hingeNodes"),
        "坏 JSON 不能 500，空数组即可");
  }

  @Test
  @DisplayName("content.model.declared 从 recipe_json 回读；坏 JSON 也不 500")
  void contentModelCarriesDeclaredDimensions() {
    final Map<String, Object> out = service.adminContent(1L);
    final Map<?, ?> declared = (Map<?, ?>) ((Map<?, ?>) out.get("model")).get("declared");
    assertEquals(990.0, declared.get("w"));
    assertEquals(871.0, declared.get("d"));
    assertEquals(1980.0, declared.get("h"));

    header.put("recipe_json", "not-json");
    final Map<String, Object> broken = service.adminContent(1L);
    final Map<?, ?> bad = (Map<?, ?>) ((Map<?, ?>) broken.get("model")).get("declared");
    assertTrue(bad.containsKey("w"), "坏 recipe_json 也要有三键，编辑页才好回填空值");
    assertEquals(null, bad.get("w"));
    assertEquals(null, bad.get("d"));
    assertEquals(null, bad.get("h"));
  }

  @Test
  @DisplayName("老产品无 product_content：detail 200 legacy-projection，不 404/500")
  void legacyProductGetsProjection() {
    when(repo.productByCatalogId("dw-test")).thenReturn(header);
    row.set(null);
    final ProductContentService.Detail d = service.detail("dw-test");
    assertEquals("legacy-projection", d.body().get("source"));
    assertEquals(0, d.body().get("publishedRev"));
    assertEquals("产品简介", ((Map<?, ?>) d.body().get("content")).get("description"));
    assertTrue(d.etag().startsWith("W/"));
    assertEquals(0, ((Map<?, ?>) d.body().get("counts")).get("total"));
  }

  @Test
  @DisplayName("保存内容 + 发布后 detail 立即可读；publishedRev 前进")
  void saveAndPublishThenDetailIsReadable() {
    when(repo.productByCatalogId("dw-test")).thenReturn(header);
    Map<String, Object> empty = new LinkedHashMap<>();
    empty.put("rev", 0);
    empty.put("published_rev", 0);
    empty.put("draft_json", Json.write(Map.of("sellingPoints", List.of(), "params", List.of()), 0));
    row.set(empty);

    when(repo.saveDraft(eq(1L), anyString(), any(), eq(0), anyString())).thenAnswer(inv -> {
      final Map<String, Object> next = new LinkedHashMap<>(row.get());
      next.put("rev", 1);
      next.put("draft_json", inv.getArgument(1));
      row.set(next);
      return true;
    });
    when(repo.publish(eq(1L), anyString(), eq(1), anyString())).thenAnswer(inv -> {
      final Map<String, Object> next = new LinkedHashMap<>(row.get());
      next.put("published_rev", 1);
      next.put("published_json", inv.getArgument(1));
      next.put("published_at", "2026-10-23T14:00:00+08:00");
      row.set(next);
      return true;
    });

    final Map<String, Object> saved = service.saveContent(1L,
        Map.of("sellingPoints", List.of("卖点一"), "params", List.of(
            Map.of("key", "容积", "value", "510", "unit", "L", "group", "制冷")), "expectedRev", 0),
        "tester");
    assertEquals(1, saved.get("rev"));
    assertEquals(false, saved.get("published"));

    final Map<String, Object> published = service.publish(1L, Map.of("expectedRev", 1), "tester");
    assertEquals(true, published.get("published"));
    assertEquals(1, published.get("rev"));

    final ProductContentService.Detail d = service.detail("dw-test");
    assertEquals("published", d.body().get("source"));
    assertEquals(1, d.body().get("publishedRev"));
    assertEquals(List.of("卖点一"), ((Map<?, ?>) d.body().get("content")).get("sellingPoints"));
  }

  @Test
  @DisplayName("发布失败：返回 published:false，旧 publishedRev 保留，编辑态 rev 已前进")
  void publishFailureKeepsOldSnapshot() {
    final Map<String, Object> r = new LinkedHashMap<>();
    r.put("rev", 3);
    r.put("published_rev", 2);
    r.put("draft_json", Json.write(Map.of("sellingPoints", List.of("新卖点"),
        "params", List.of()), 0));
    r.put("published_json", Json.write(Map.of(
        "content", Map.of("description", "旧简介", "sellingPoints", List.of("旧卖点"), "params", List.of()),
        "hotspots", List.of(),
        "model", Map.of("modelId", 9, "variant", "default", "checksum", "abc123", "unit", "mm",
            "bboxMm", Map.of("w", 990, "d", 871, "h", 1980)),
        "validation", Map.of("checkedAt", "2026-10-23T13:00:00+08:00",
            "modelFingerprint", "default:abc123", "unit", "mm", "invalid", List.of()),
        "publishedRev", 2, "publishedAt", "2026-10-23T13:00:00+08:00"), 0));
    row.set(r);
    when(repo.publish(eq(1L), anyString(), eq(3), anyString())).thenReturn(false);

    final Map<String, Object> out = service.publish(1L, Map.of("expectedRev", 3), "tester");
    assertEquals(false, out.get("published"));
    assertEquals(2, out.get("publishedRev"));
    assertNotNull(out.get("publishError"));
    assertEquals(3, row.get().get("rev"), "发布失败不回滚编辑态");
    assertEquals(2, row.get().get("published_rev"), "旧快照继续对外");
    verify(audit).write(anyString(), eq("product.content.publish"), eq("product"), eq("DEMO-TEST"), anyString());
  }

  @Test
  @DisplayName("expectedRev 过期：409 stale-content-rev，不写")
  void staleRevIsRejected() {
    final Map<String, Object> r = new LinkedHashMap<>();
    r.put("rev", 5);
    r.put("published_rev", 5);
    r.put("draft_json", Json.write(Map.of("sellingPoints", List.of(), "params", List.of()), 0));
    row.set(r);
    final ApiProblem p = assertThrows(ApiProblem.class,
        () -> service.saveContent(1L, Map.of("sellingPoints", List.of(), "params", List.of(),
            "expectedRev", 4), "tester"));
    assertEquals(409, p.status());
    assertEquals("conflict", p.reason());
    assertEquals("stale-content-rev", p.extra().get("code"));
    verify(repo, never()).saveDraft(anyLong(), anyString(), any(), anyInt(), anyString());
  }

  @Test
  @DisplayName("结构性错误：422 content-invalid + issues，不写")
  void structuralErrorIs422() {
    final List<Map<String, Object>> many = new ArrayList<>();
    for (int i = 0; i < 51; i++) many.add(Map.of("title", "t", "body", "b",
        "nodePath", List.of("root"), "nodeIndex", 0,
        "position", Map.of("x", 0, "y", 0, "z", 0), "doorState", "any"));
    final ApiProblem p = assertThrows(ApiProblem.class,
        () -> service.saveContent(1L, Map.of("sellingPoints", List.of(), "params", List.of(),
            "hotspots", many, "expectedRev", 0), "tester"));
    assertEquals(422, p.status());
    assertEquals("content-invalid", p.extra().get("code"));
    assertTrue(((List<?>) p.extra().get("issues")).size() >= 1);
    verify(repo, never()).saveContentAndHotspots(anyLong(), anyString(), any(), any(), anyInt(), anyString());
  }

  @Test
  @DisplayName("合并入口：内容+热点一次写，自动发布，返回 published:true")
  void combinedEntryPublishesOnce() {
    Map<String, Object> r = new LinkedHashMap<>();
    r.put("rev", 0);
    r.put("published_rev", 0);
    r.put("draft_json", Json.write(Map.of("sellingPoints", List.of(), "params", List.of()), 0));
    row.set(r);
    when(repo.saveContentAndHotspots(eq(1L), anyString(), any(), any(), eq(0), anyString())).thenAnswer(inv -> {
      final Map<String, Object> next = new LinkedHashMap<>(row.get());
      next.put("rev", 1);
      next.put("draft_json", inv.getArgument(1));
      row.set(next);
      return List.of(12L);
    });
    when(repo.publish(eq(1L), anyString(), eq(1), anyString())).thenAnswer(inv -> {
      final Map<String, Object> next = new LinkedHashMap<>(row.get());
      next.put("published_rev", 1);
      next.put("published_json", inv.getArgument(1));
      row.set(next);
      return true;
    });

    final Map<String, Object> hotspot = new LinkedHashMap<>();
    hotspot.put("title", "门内托盘");
    hotspot.put("body", "说明");
    hotspot.put("nodePath", List.of("root", "door"));
    hotspot.put("nodeIndex", 0);
    hotspot.put("position", Map.of("x", 0.1, "y", 0.5, "z", 0.2));
    hotspot.put("doorState", "open");
    hotspot.put("camera", Map.of("azimuthDeg", 30, "elevationDeg", 10,
        "distFactor", 1.5, "target", List.of(0.5, 0.5, 0.5), "fov", 45));

    final Map<String, Object> out = service.saveContent(1L, Map.of(
        "sellingPoints", List.of("卖点"), "params", List.of(),
        "hotspots", List.of(hotspot), "expectedRev", 0), "tester");
    assertEquals(true, out.get("published"));
    assertEquals(1, out.get("rev"));
    assertEquals(List.of(12L), out.get("hotspotIds"));
  }

  @Test
  @DisplayName("锚点局部坐标可在全局 bbox 外：不再误判 hotspot-out-of-bounds（验收-3）")
  void localAnchorCoordinatesOutsideGlobalBboxAreAccepted() {
    final Map<String, Object> r = new LinkedHashMap<>();
    r.put("rev", 0);
    r.put("published_rev", 0);
    r.put("draft_json", Json.write(Map.of("sellingPoints", List.of(), "params", List.of()), 0));
    row.set(r);
    when(repo.saveContentAndHotspots(eq(1L), anyString(), any(), any(), eq(0), anyString())).thenAnswer(inv -> {
      final Map<String, Object> next = new LinkedHashMap<>(row.get());
      next.put("rev", 1);
      next.put("draft_json", inv.getArgument(1));
      row.set(next);
      return List.of(12L);
    });
    when(repo.publish(eq(1L), anyString(), eq(1), anyString())).thenAnswer(inv -> {
      final Map<String, Object> next = new LinkedHashMap<>(row.get());
      next.put("published_rev", 1);
      next.put("published_json", inv.getArgument(1));
      row.set(next);
      return true;
    });

    // body 锚点原点在模型中部：底部点的节点局部 y 可以是负数，远超全局 bbox 的 -0.5 m 下限。
    final Map<String, Object> hotspot = new LinkedHashMap<>();
    hotspot.put("title", "底部铭牌");
    hotspot.put("body", "锚点局部坐标，不是世界坐标");
    hotspot.put("nodePath", List.of("root", "body", "bottom"));
    hotspot.put("nodeIndex", 0);
    hotspot.put("position", Map.of("x", 0.0, "y", -0.99, "z", 0.2));
    hotspot.put("normal", Map.of("x", 0, "y", 0, "z", 1));
    hotspot.put("camera", Map.of("azimuthDeg", 30, "elevationDeg", 10,
        "distFactor", 1.5, "target", List.of(0.5, 0.5, 0.5), "fov", 45));

    final Map<String, Object> out = service.saveContent(1L, Map.of(
        "sellingPoints", List.of(), "params", List.of(),
        "hotspots", List.of(hotspot), "expectedRev", 0), "tester");
    assertEquals(true, out.get("published"));
    assertEquals(List.of(12L), out.get("hotspotIds"));
    verify(repo).saveContentAndHotspots(anyLong(), anyString(), any(), any(), anyInt(), anyString());
  }

  @Test
  @DisplayName("热点标题/正文为空：422 且一个字都不写（P0-QA-07）")
  void blankHotspotTextIsRejectedBeforeWrite() {
    final Map<String, Object> r = new LinkedHashMap<>();
    r.put("rev", 0);
    r.put("published_rev", 0);
    r.put("draft_json", Json.write(Map.of("sellingPoints", List.of(), "params", List.of()), 0));
    row.set(r);

    final Map<String, Object> hotspot = new LinkedHashMap<>();
    hotspot.put("title", "  ");
    hotspot.put("body", "");
    hotspot.put("nodePath", List.of("root", "door"));
    hotspot.put("nodeIndex", 0);
    hotspot.put("position", Map.of("x", 0.1, "y", 0.5, "z", 0.2));

    final ApiProblem ex = assertThrows(ApiProblem.class, () -> service.saveContent(1L, Map.of(
        "sellingPoints", List.of(), "params", List.of(),
        "hotspots", List.of(hotspot), "expectedRev", 0), "tester"));
    assertEquals(422, ex.status());
    assertEquals("invalid-request", ex.reason());
    verify(repo, never()).saveContentAndHotspots(anyLong(), anyString(), any(), any(), anyInt(), anyString());
  }

  @Test
  @DisplayName("热点坐标有限但超出 DECIMAL 范围：422，不能留到 DB 绑定时变 500（验收-3）")
  void absurdlyLargeFinitePositionIsRejectedBeforeWrite() {
    final Map<String, Object> r = new LinkedHashMap<>();
    r.put("rev", 0);
    r.put("published_rev", 0);
    r.put("draft_json", Json.write(Map.of("sellingPoints", List.of(), "params", List.of()), 0));
    row.set(r);

    final Map<String, Object> hotspot = new LinkedHashMap<>();
    hotspot.put("title", "异常坐标");
    hotspot.put("body", "1e9 不是几何错误，是数据类型边界");
    hotspot.put("nodePath", List.of("root", "body"));
    hotspot.put("nodeIndex", 0);
    hotspot.put("position", Map.of("x", 1_000_000_000.0, "y", 0.0, "z", 0.0));

    final ApiProblem ex = assertThrows(ApiProblem.class, () -> service.saveContent(1L, Map.of(
        "sellingPoints", List.of(), "params", List.of(),
        "hotspots", List.of(hotspot), "expectedRev", 0), "tester"));
    assertEquals(422, ex.status());
    assertEquals("invalid-request", ex.reason());
    verify(repo, never()).saveContentAndHotspots(anyLong(), anyString(), any(), any(), anyInt(), anyString());
  }

  @Test
  @DisplayName("动作库：GET content 透出 actions，target/motion 解析为对象")
  void adminContentCarriesActions() {
    final Map<String, Object> r = new LinkedHashMap<>();
    r.put("rev", 0);
    r.put("published_rev", 0);
    r.put("draft_json", Json.write(Map.of("sellingPoints", List.of(), "params", List.of()), 0));
    row.set(r);
    actionRows.set(List.of(Map.of(
        "action_key", "door-open", "name", "开门", "kind", "rotate",
        "target_json", "{\"path\":[\"#0\",\"Scene\",\"DEMO-SC-100\",\"door\"],\"index\":0}",
        "motion_json", "{\"axis\":\"y\",\"angleDeg\":105,\"direction\":\"+\",\"pivotMm\":[287.71,70,363],\"durationMs\":600,\"toggle\":true}")));

    final Map<String, Object> out = service.adminContent(1L);
    final List<?> actions = (List<?>) out.get("actions");
    assertEquals(1, actions.size());
    final Map<?, ?> a = (Map<?, ?>) actions.get(0);
    assertEquals("door-open", a.get("key"));
    assertEquals("开门", a.get("name"));
    assertEquals(0, ((Map<?, ?>) a.get("target")).get("index"));
    assertEquals(105, ((Map<?, ?>) a.get("motion")).get("angleDeg"));
  }

  @Test
  @DisplayName("动作库：PUT hotspots 带 actions 同事务保存，发布快照含 actions 与热点引用")
  void saveHotspotsPersistsActionsAndPublishesSnapshot() {
    final Map<String, Object> r = new LinkedHashMap<>();
    r.put("rev", 1);
    r.put("published_rev", 0);
    r.put("draft_json", Json.write(Map.of("sellingPoints", List.of(), "params", List.of()), 0));
    row.set(r);
    when(repo.hotspots(1L)).thenReturn(List.of(Map.of("id", 12L)));
    final Map<String, Object> action = Map.of(
        "key", "door-open", "name", "开门", "kind", "rotate",
        "target", Map.of("path", List.of("#0", "Scene", "DEMO-SC-100", "door"), "index", 0),
        "motion", Map.of("axis", "y", "angleDeg", 105, "direction", "+",
            "pivotMm", List.of(287.71, 70, 363), "durationMs", 600, "toggle", true));
    final Map<String, Object> hotspot = new LinkedHashMap<>();
    hotspot.put("id", 12L);
    hotspot.put("title", "铰链");
    hotspot.put("body", "开门");
    hotspot.put("nodePath", List.of("#0", "Scene", "DEMO-SC-100", "body"));
    hotspot.put("nodeIndex", 0);
    hotspot.put("position", Map.of("x", 0.1, "y", 0.9, "z", 0.3));
    hotspot.put("actionKey", "door-open");
    when(repo.saveHotspots(eq(1L), anyString(), any(), any(), eq(1), anyString()))
        .thenReturn(List.of(12L));

    final Map<String, Object> saved = service.saveHotspots(1L, Map.of(
        "hotspots", List.of(hotspot), "actions", List.of(action), "expectedRev", 1), "tester");
    assertEquals(2, saved.get("rev"));
    verify(repo).saveHotspots(eq(1L), anyString(), any(), any(), eq(1), anyString());
    row.get().put("rev", 2);

    // 发布：动作库从 repo.actions 读出，快照同时带 actions 和热点 actionKey
    final Map<String, Object> hsRow = new LinkedHashMap<>();
    hsRow.put("id", 12L);
    hsRow.put("seq", 0);
    hsRow.put("title", "铰链");
    hsRow.put("body", "开门");
    hsRow.put("node_path", "[\"#0\",\"Scene\",\"DEMO-SC-100\",\"body\"]");
    hsRow.put("node_index", 0);
    hsRow.put("node_name", "body");
    hsRow.put("pos_x", 0.1);
    hsRow.put("pos_y", 0.9);
    hsRow.put("pos_z", 0.3);
    hsRow.put("door_state", "any");
    hsRow.put("camera_json", null);
    hsRow.put("action_key", "door-open");
    when(repo.hotspots(1L)).thenReturn(List.of(hsRow));
    when(repo.actions(1L)).thenReturn(List.of(Map.of(
        "action_key", "door-open", "name", "开门", "kind", "rotate",
        "target_json", "{\"path\":[\"#0\",\"Scene\",\"DEMO-SC-100\",\"door\"],\"index\":0}",
        "motion_json", "{\"axis\":\"y\",\"angleDeg\":105,\"direction\":\"+\"}")));
    when(repo.publish(eq(1L), anyString(), eq(2), anyString())).thenAnswer(inv -> {
      final Map<String, Object> next = new LinkedHashMap<>(row.get());
      next.put("published_rev", 2);
      next.put("published_json", inv.getArgument(1));
      row.set(next);
      return true;
    });
    final org.mockito.ArgumentCaptor<String> snap = org.mockito.ArgumentCaptor.forClass(String.class);
    final Map<String, Object> out = service.publish(1L, Map.of("expectedRev", 2), "tester");
    assertEquals(true, out.get("published"));
    verify(repo).publish(eq(1L), snap.capture(), eq(2), anyString());
    final Map<?, ?> snapMap = (Map<?, ?>) Json.parse(snap.getValue());
    assertTrue(snapMap.containsKey("actions"));
    final List<?> snapHotspots = (List<?>) snapMap.get("hotspots");
    assertEquals("door-open", ((Map<?, ?>) snapHotspots.get(0)).get("actionKey"));
  }

  @Test
  @DisplayName("动作库：热点引用未知 actionKey → 422，且不写热点/动作")
  void unknownActionKeyIsRejected() {
    final Map<String, Object> r = new LinkedHashMap<>();
    r.put("rev", 0);
    r.put("published_rev", 0);
    r.put("draft_json", Json.write(Map.of("sellingPoints", List.of(), "params", List.of()), 0));
    row.set(r);
    final Map<String, Object> hotspot = new LinkedHashMap<>();
    hotspot.put("title", "铰链");
    hotspot.put("body", "绑定不存在的动作");
    hotspot.put("nodePath", List.of("root", "body"));
    hotspot.put("nodeIndex", 0);
    hotspot.put("position", Map.of("x", 0.1, "y", 0.5, "z", 0.2));
    hotspot.put("actionKey", "missing");
    final ApiProblem p = assertThrows(ApiProblem.class, () -> service.saveHotspots(1L,
        Map.of("hotspots", List.of(hotspot), "actions", List.of(), "expectedRev", 0), "tester"));
    assertEquals(422, p.status());
    assertTrue(String.valueOf(p.extra().get("issues")).contains("missing"));
    verify(repo, never()).saveHotspots(anyLong(), anyString(), any(), any(), anyInt(), anyString());
  }

  @Test
  @DisplayName("旧发布快照无 actions：detail 返回空数组，热点补 actionKey=null")
  void legacySnapshotGetsEmptyActions() {
    final Map<String, Object> pub = new LinkedHashMap<>();
    pub.put("rev", 1);
    pub.put("published_rev", 1);
    pub.put("draft_json", Json.write(Map.of("sellingPoints", List.of(), "params", List.of()), 0));
    pub.put("published_json", Json.write(Map.of(
        "content", Map.of("description", "旧", "sellingPoints", List.of(), "params", List.of()),
        "hotspots", List.of(Map.of("id", 12L, "seq", 0, "title", "旧热点", "body", "旧",
            "nodePath", List.of("root", "body"), "nodeIndex", 0,
            "position", Map.of("x", 0.1, "y", 0.5, "z", 0.2))),
        "model", Map.of("modelId", 9, "variant", "default", "checksum", "abc123", "unit", "mm"),
        "validation", Map.of("modelFingerprint", "default:abc123", "invalid", List.of()),
        "publishedRev", 1, "publishedAt", "2026-10-23T13:00:00+08:00"), 0));
    row.set(pub);
    when(repo.productByCatalogId("dw-test")).thenReturn(header);
    final ProductContentService.Detail d = service.detail("dw-test");
    assertEquals(List.of(), d.body().get("actions"));
    final List<?> hs = (List<?>) d.body().get("hotspots");
    assertTrue(((Map<?, ?>) hs.get(0)).containsKey("actionKey"));
    assertEquals(null, ((Map<?, ?>) hs.get(0)).get("actionKey"));
  }

  @Test
  @DisplayName("可见性：draft / 无文件 / LOD 失败都能说出原因，active 且有 LOD 才 frontVisible")
  void visibilityReasonsAreExplicit() {
    final Map<String, Object> ok = new LinkedHashMap<>(header);
    ok.put("lod_json", "{\"levels\":[{\"name\":\"lod0\"}]}");
    assertTrue(ProductVisibility.visible(ok));
    assertEquals("", ProductVisibility.reason(ok));

    final Map<String, Object> draft = new LinkedHashMap<>(ok);
    draft.put("status", "draft");
    assertFalse(ProductVisibility.visible(draft));
    assertTrue(ProductVisibility.reason(draft).contains("草稿"));

    final Map<String, Object> noFile = new LinkedHashMap<>(ok);
    noFile.put("file_path", "");
    assertFalse(ProductVisibility.visible(noFile));
    assertTrue(ProductVisibility.reason(noFile).contains("LOD"));

    final Map<String, Object> failed = new LinkedHashMap<>(noFile);
    failed.put("delta_vs_source_json", "{\"lodError\":\"压缩失败\"}");
    assertTrue(ProductVisibility.reason(failed).contains("压缩失败"));
  }
}
