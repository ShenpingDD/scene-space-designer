package com.scene.spatial.params;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ParamsSchemaTest —— 规格与校验（R6-4 B4a）
 *
 * 钉三件事：
 *  ① 规格的**规模**（9 组 / 45 项 / 7 项不允许在后台改）—— 漂了要显式改断言；
 *  ② 每一条判据都真的会拒（未知项 / 非数字 / 超范围 / 不许改 / 黄灯≥绿灯）；
 *  ③ **拒的时候说了什么** —— 界面要把这些话原样显示给用户，「参数不合法」四个字没用。
 */
class ParamsSchemaTest {

  private final ParamsSchema schema = new ParamsSchema();

  private Map<String, Object> values() {
    return schema.defaults();
  }

  @Test
  @DisplayName("规格规模：12 组 / 64 项 / 其中 7 项不允许在后台改")
  void shapeIsPinned() {
    assertEquals(12, schema.groups().size());
    assertEquals(64, schema.size());
    assertEquals(7, schema.entries().stream().filter(e -> !e.admin()).count());
    assertNotNull(schema.entry("door.openOkDeg"));
    assertEquals("设备柜门净空", schema.entry("door.openOkDeg").groupLabel());
  }

  @Test
  @DisplayName("合法补丁：过（问题清单为空）")
  void acceptsValid() {
    final Map<String, Object> patch = Map.of("door", Map.of("openOkDeg", 85));
    assertTrue(schema.validate(patch, values()).isEmpty());
  }

  @Test
  @DisplayName("未知分组 / 未知项：拒，并指出可用的是哪些")
  void rejectsUnknown() {
    final List<Map<String, Object>> e1 = schema.validate(Map.of("nope", Map.of("x", 1)), values());
    assertEquals(1, e1.size());
    assertTrue(String.valueOf(e1.get(0).get("message")).contains("未知分组"), String.valueOf(e1.get(0)));

    final List<Map<String, Object>> e2 = schema.validate(Map.of("door", Map.of("openOKDeg", 85)), values());
    assertEquals(1, e2.size());
    assertTrue(String.valueOf(e2.get(0).get("message")).contains("未知参数"), String.valueOf(e2.get(0)));
  }

  @Test
  @DisplayName("不是数字 / 超出范围：拒，并把范围原文写清楚")
  void rejectsBadValues() {
    final List<Map<String, Object>> e1 = schema.validate(Map.of("door", Map.of("openOkDeg", "85")), values());
    assertTrue(String.valueOf(e1.get(0).get("message")).contains("必须是数字"), String.valueOf(e1.get(0)));

    final List<Map<String, Object>> e2 = schema.validate(Map.of("door", Map.of("openOkDeg", 200)), values());
    assertTrue(String.valueOf(e2.get(0).get("message")).contains("超出范围"), String.valueOf(e2.get(0)));
    assertTrue(String.valueOf(e2.get(0).get("message")).contains("0~180"), String.valueOf(e2.get(0)));
  }

  @Test
  @DisplayName("admin:false 的项：拒，理由照 help 原文给（不是藏起来当没有）")
  void rejectsNonAdminItems() {
    final List<Map<String, Object>> e = schema.validate(Map.of("door", Map.of("sweepStepDeg", 5)), values());
    assertEquals(1, e.size());
    final String msg = String.valueOf(e.get(0).get("message"));
    assertTrue(msg.contains("不允许改"), msg);
    assertTrue(msg.contains("Java 侧必须同口径"), msg);
  }

  @Test
  @DisplayName("跨字段：黄灯阈值不得 ≥ 绿灯阈值（与 JS 侧同两条）")
  void rejectsCrossField() {
    final List<Map<String, Object>> e1 = schema.validate(
        Map.of("door", Map.of("openWarnDeg", 95)), values());
    assertTrue(String.valueOf(e1.get(0).get("message")).contains("不能高于"), String.valueOf(e1.get(0)));

    final List<Map<String, Object>> e2 = schema.validate(
        Map.of("door", Map.of("openWarnDeg", 90)), values());
    assertTrue(String.valueOf(e2.get(0).get("message")).contains("取消了黄灯级别"), String.valueOf(e2.get(0)));

    assertTrue(schema.validate(Map.of("door", Map.of("openWarnDeg", 85)), values()).isEmpty());
  }

  @Test
  @DisplayName("一次给全部问题（不是改一个报一个）")
  void reportsAllAtOnce() {
    final Map<String, Object> patch = new LinkedHashMap<>();
    patch.put("door", Map.of("openOkDeg", 200, "openWarnDeg", 300));
    patch.put("nope", Map.of("x", 1));
    final List<Map<String, Object>> errors = schema.validate(patch, values());
    // 4 条不是 3 条：除了两项超范围 + 一个未知分组，**跨字段那条也会报**
    // （黄灯 300 > 绿灯 200）。这是刻意的 —— 两个值单看都错的时候，
    // 组合关系的问题也该一并说出来，用户一次就能看清全部原因。JS 侧同此。
    assertEquals(4, errors.size(), errors.toString());
  }
}
