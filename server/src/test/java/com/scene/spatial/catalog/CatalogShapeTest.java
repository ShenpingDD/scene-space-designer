package com.scene.spatial.catalog;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * CatalogShapeTest —— 装配是纯函数，所以这里不需要数据库
 *
 * 最要紧的一条：**占地用 `recipe_json` 的声明包络，不是 `product_model` 的实测包围盒**。
 * 这一条差点写错（把 w 映成 bbox_w）：demo-freezer-dual 是 `fit` 模型，实测网格只有 525.5 mm 宽、
 * 声明包络是 990 mm —— 混用的话"占地"会随模型网格大小变化，而它与厂家规格无关，
 * 界面（catalog.js）用的又是声明包络，两边会各判各的。
 */
class CatalogShapeTest {

  private static Map<String, Object> row() {
    final Map<String, Object> r = new LinkedHashMap<>();
    r.put("db_id", 1L);
    r.put("model_no", "DEMO-FZ-040");
    r.put("name", "双温双控低温保存箱");
    r.put("series", "");
    r.put("description", "介绍");
    r.put("origin", "官网外观重建");
    r.put("size_note", "演示比例 · 非产品尺寸");
    r.put("color", "#286eac");
    r.put("source_url", null);
    r.put("recipe_json", "{\"id\":\"demo-freezer-dual\",\"w\":990,\"d\":871.2,\"h\":1980,\"doors\":[{\"node\":\"upper_door\",\"axis\":\"y\",\"openAngleRad\":1.85}]}");
    r.put("variant", "default");
    r.put("file_path", "assets/optimized/DEMO-FZ-040.lod0.glb");
    r.put("source_file_path", "assets/models/DEMO-FZ-040.glb");
    r.put("thumb_file", null);
    r.put("envelope_mode", "fit");
    r.put("bbox_w", 525.5);      // 实测：只有声明的一半（fit 模型）
    r.put("bbox_d", 517.0);
    r.put("bbox_h", 990.0);
    r.put("hinge_nodes", "[{\"node\":\"upper_door\",\"axis\":\"y\",\"openAngleDeg\":106,\"hinge\":{\"x\":0.4,\"y\":1.25,\"z\":0.33},\"leaf\":{\"x0\":-0.44,\"x1\":0.43,\"z0\":0.28,\"z1\":0.43},\"swing\":0.86}]");
    r.put("lod_json", "{\"levels\":[{\"md5\":\"abc123\"}]}");
    return r;
  }

  private static Map<String, Object> note(Object pid, String kind, String label, String value, int sort) {
    final Map<String, Object> n = new LinkedHashMap<>();
    n.put("product_id", pid);
    n.put("kind", kind);
    n.put("label", label);
    n.put("value", value);
    n.put("sort_order", sort);
    return n;
  }

  private static List<Map<String, Object>> notes() {
    return List.of(
        note(1L, "fact", "有效容积", "510 L", 0),
        note(1L, "feature", "独立双控", "上下箱体独立", 0),
        note(1L, "fact", "箱内温度", "-20～-40℃", 1));
  }

  @Test
  void 占地用声明包络而不是实测包围盒() {
    final Map<String, Object> p = DbCatalog.shapeProduct(row(), notes());
    assertNotNull(p);
    assertEquals(0.99, (Double) p.get("w"), 1e-9, "声明包络 990 mm → 0.99 m");
    assertEquals(0.8712, (Double) p.get("d"), 1e-9);
    assertEquals(1.98, (Double) p.get("h"), 1e-9);
    @SuppressWarnings("unchecked")
    final Map<String, Object> bbox = (Map<String, Object>) p.get("bboxMm");
    assertEquals(525.5, (Double) bbox.get("w"), 1e-9, "实测包围盒另放一栏，两个口径不互相污染");
  }

  @Test
  void 说明条目按kind分成两栏且保持原有顺序() {
    final Map<String, Object> p = DbCatalog.shapeProduct(row(), notes());
    @SuppressWarnings("unchecked")
    final Map<String, Object> n = (Map<String, Object>) p.get("notes");
    assertEquals(List.of(List.of("有效容积", "510 L"), List.of("箱内温度", "-20～-40℃")), n.get("facts"));
    assertEquals(List.of(List.of("独立双控", "上下箱体独立")), n.get("features"));
  }

  @Test
  void 实测门与配方门分开存不合并() {
    final Map<String, Object> p = DbCatalog.shapeProduct(row(), notes());
    @SuppressWarnings("unchecked")
    final List<Map<String, Object>> doors = (List<Map<String, Object>>) p.get("doors");
    @SuppressWarnings("unchecked")
    final List<Map<String, Object>> recipeDoors = (List<Map<String, Object>>) p.get("recipeDoors");
    assertEquals("y", doors.get(0).get("axis"));
    assertEquals(106, ((Number) doors.get(0).get("openAngleDeg")).intValue());                  // 实测（度）
    assertEquals(1.85, ((Number) recipeDoors.get(0).get("openAngleRad")).doubleValue(), 1e-9);   // 声明（弧度）
  }

  @Test
  void 目录摘要只加三个字段且旧产品为零() {
    final Map<String, Object> p = DbCatalog.shapeProduct(row(), notes());
    assertEquals(0, p.get("hotspotCount"));
    assertEquals(0, p.get("contentRev"));
    assertEquals(true, p.get("hasDetail"), "有 description 的老产品 hasDetail=true（走 legacy projection）");

    final Map<String, Object> r = row();
    r.put("content_published_rev", 7);
    r.put("content_hotspot_count", 3);
    final Map<String, Object> p2 = DbCatalog.shapeProduct(r, notes());
    assertEquals(3, p2.get("hotspotCount"));
    assertEquals(7, p2.get("contentRev"));
    assertEquals(true, p2.get("hasDetail"));
  }

  @Test
  void 缩略图没生成就不写路径() {
    assertNull(DbCatalog.shapeProduct(row(), notes()).get("thumbUrl"),
        "thumb_file 为空 → 不给前端一个必然 404 的地址");
    final Map<String, Object> r = row();
    r.put("thumb_file", "assets/thumbs/DEMO-FZ-040.png");
    assertEquals("/assets/thumbs/DEMO-FZ-040.png", DbCatalog.shapeProduct(r, notes()).get("thumbUrl"));
  }

  @Test
  void 缩略图缓存键取第一级LOD的md5() {
    assertEquals("abc123", DbCatalog.shapeProduct(row(), notes()).get("modelMd5"));
  }

  @Test
  void 内核条目与Cases同形且缺声明包络时响亮跳过() {
    final Map<String, Object> e = DbCatalog.kernelEntry(DbCatalog.shapeProduct(row(), notes()));
    assertEquals(0.99, (Double) e.get("w"), 1e-9);
    assertNotNull(e.get("doors"));
    assertTrue(e.containsKey("h"));
    final Map<String, Object> broken = row();
    broken.put("recipe_json", "{\"doors\":[]}");   // 既没有 id、也没有 w/d
    assertNull(DbCatalog.shapeProduct(broken, notes()),
        "缺声明包络必须跳过（并打 WARN），不能拿 null 去占地");
  }
}
