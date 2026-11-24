package com.scene.spatial.admin;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ProductQualityTest —— 质量闸门的分层与 1:1 尺寸对账的三态。
 *
 * 这一层钉的是**用户能看见的结论**，不是实现细节：
 *   · 1:1 三轴都在容差内 → envelope_ok=1；
 *   · 任意一轴超差 → 0（逐轴判，不许被别的轴的接近平均掉）；
 *   · 无可核对数据 → NULL（未判，WARN），不是 0（判为否）；
 *   · BLOCK 只给「数据缺口」，`envelope_ok=0` / `door_verified=0` 只 WARN。
 *
 * 用例里的数字刻意写**字面量**（不读 Params）：容差被改错时这里要能抓住。
 */
class ProductQualityTest {

  /** 一行「好产品」：声明与实测一致、1:1、门型已确认、尺寸说明有。 */
  private static Map<String, Object> good() {
    final Map<String, Object> r = new LinkedHashMap<>();
    r.put("file_path", "assets/optimized/demo-99.lod0.glb");
    r.put("unit", "mm");
    r.put("recipe_json", "{\"id\":\"demo-99\",\"w\":600,\"d\":700,\"h\":800}");
    r.put("bbox_w", 600);
    r.put("bbox_d", 700);
    r.put("bbox_h", 800);
    r.put("envelope_mode", "1:1");
    r.put("envelope_ok", 1);
    r.put("door_part", "single");
    r.put("door_verified", 1);
    r.put("size_note", "厂家图册，实测一致");
    return r;
  }

  @Test
  @DisplayName("1:1 三轴相符 → envelope_ok=1，闸门无问题")
  void matchingEnvelopeIsOne() {
    assertEquals(1, ProductQuality.envelopeOk("1:1", 600, 700, 800, 600, 700, 800));
    final ProductQuality.Gate g = ProductQuality.gate(good());
    assertFalse(g.blocked(), g.summary());
    assertEquals(0, g.warnCount(), g.summary());
    assertEquals("ok", g.level());
  }

  @Test
  @DisplayName("逐轴判：w 差 0.5 mm 可以，d 差 12 mm 就是 0 —— 不被平均掉")
  void oneAxisOverToleranceIsZero() {
    // w/d 都在 1 mm 内，只有 h 差 3 mm
    assertEquals(0, ProductQuality.envelopeOk("1:1", 600, 700, 800, 600.5, 700, 803),
        "h 差 3 mm 超容差 → 0（逐轴比较，不是平均比值）");
    // 只差一轴 d
    assertEquals(0, ProductQuality.envelopeOk("1:1", 600, 700, 800, 600, 712, 800));

    final Map<String, Object> row = good();
    row.put("bbox_h", 803);
    final ProductQuality.Gate g = ProductQuality.gate(row);
    assertFalse(g.blocked(), "超差是结论不是数据缺口 → 不 BLOCK：" + g.summary());
    assertTrue(g.summary().contains("尺寸未对账"), g.summary());
    assertTrue(g.summary().contains("h 声明 800"), "要点名是哪一轴：" + g.summary());
  }

  @Test
  @DisplayName("无可核对数据 → envelope_ok=NULL（未判，WARN），不许悄悄通过")
  void missingMeasurementIsUnjudgedNotZero() {
    assertNull(ProductQuality.envelopeOk("1:1", 600, 700, 800, null, null, null));
    final Map<String, Object> row = good();
    row.remove("bbox_w");
    row.remove("bbox_d");
    row.remove("bbox_h");
    final ProductQuality.Gate g = ProductQuality.gate(row);
    assertFalse(g.blocked(), "没有实测数据是「判不了」，不是数据坏 → 不 BLOCK：" + g.summary());
    assertEquals(1, g.warnCount(), g.summary());
    assertTrue(g.summary().contains("尺寸未判"), g.summary());
  }

  @Test
  @DisplayName("声明尺寸缺失 → BLOCK（声明是对账的另一半）")
  void missingDeclaredEnvelopeBlocks() {
    final Map<String, Object> row = good();
    row.put("recipe_json", "{\"id\":\"demo-99\"}");
    final ProductQuality.Gate g = ProductQuality.gate(row);
    assertTrue(g.blocked(), g.summary());
    assertTrue(g.summary().contains("声明尺寸"), g.summary());
  }

  @Test
  @DisplayName("单位不是 mm / 缺失 → BLOCK")
  void wrongUnitBlocks() {
    final Map<String, Object> cm = good();
    cm.put("unit", "cm");
    assertTrue(ProductQuality.gate(cm).blocked());

    final Map<String, Object> none = good();
    none.put("unit", "");
    assertTrue(ProductQuality.gate(none).blocked());
  }

  @Test
  @DisplayName("门型为空 → BLOCK（没填 ≠ 没有门）；显式 none 且已验证 → 不报门")
  void emptyDoorPartBlocksButNoneIsFine() {
    final Map<String, Object> empty = good();
    empty.put("door_part", null);
    final ProductQuality.Gate g = ProductQuality.gate(empty);
    assertTrue(g.blocked(), g.summary());
    assertTrue(g.summary().contains("门型"), g.summary());

    final Map<String, Object> noDoor = good();
    noDoor.put("door_part", "none");
    noDoor.put("door_verified", 1);
    final ProductQuality.Gate g2 = ProductQuality.gate(noDoor);
    assertFalse(g2.blocked(), g2.summary());
    assertFalse(g2.summary().contains("门型"), "已验证无门不是缺口：" + g2.summary());
  }

  @Test
  @DisplayName("door_verified=0 只是 WARN（不是「没有门」）")
  void unverifiedDoorIsWarnOnly() {
    final Map<String, Object> row = good();
    row.put("door_verified", 0);
    final ProductQuality.Gate g = ProductQuality.gate(row);
    assertFalse(g.blocked(), g.summary());
    assertEquals(1, g.warnCount(), g.summary());
    assertTrue(g.summary().contains("门型未确认"), g.summary());
  }

  @Test
  @DisplayName("size_note 为空 → BLOCK（新建/激活必须写）")
  void emptySizeNoteBlocks() {
    final Map<String, Object> row = good();
    row.put("size_note", "");
    final ProductQuality.Gate g = ProductQuality.gate(row);
    assertTrue(g.blocked(), g.summary());
    assertTrue(g.summary().contains("尺寸说明"), g.summary());
  }

  @Test
  @DisplayName("fit + envelope_ok=0 不 BLOCK（种子 2 那种刻意缩放不能被判死）")
  void fitModeZeroDoesNotBlock() {
    final Map<String, Object> row = good();
    row.put("envelope_mode", "fit");
    row.put("envelope_ok", 0);
    row.put("bbox_w", 660);   // fit 下声明与实测本来不同
    final ProductQuality.Gate g = ProductQuality.gate(row);
    assertFalse(g.blocked(), g.summary());
    assertFalse(g.summary().contains("尺寸未对账"), g.summary());
  }

  @Test
  @DisplayName("给 QA 的逐轴读数：每轴 declared/measured/delta/tol/ok")
  void axesReadoutIsPerAxis() {
    final List<Map<String, Object>> axes = ProductQuality.envelopeAxes(600, 700, 800, 600, 712, 800);
    assertEquals(3, axes.size());
    assertEquals("w", axes.get(0).get("axis"));
    assertEquals(true, axes.get(0).get("ok"));
    assertEquals("d", axes.get(1).get("axis"));
    assertEquals(false, axes.get(1).get("ok"));
    assertEquals(12.0, axes.get(1).get("deltaMm"));
    assertEquals(1, axes.get(1).get("tolMm"));
    assertEquals("h", axes.get(2).get("axis"));
    assertEquals(true, axes.get(2).get("ok"));
  }

  @Test
  @DisplayName("toMap 给接口：level / blocked / 逐条 code")
  void gateMapExposesVerdictAndReasons() {
    final Map<String, Object> row = good();
    row.put("bbox_h", 803);
    final Map<String, Object> m = ProductQuality.gate(row).toMap();
    assertEquals("warn", m.get("level"));
    assertEquals(false, m.get("blocked"));
    assertEquals(0, m.get("blockCount"));
    assertEquals(1, m.get("warnCount"));
    @SuppressWarnings("unchecked")
    final List<Map<String, Object>> issues = (List<Map<String, Object>>) m.get("issues");
    assertEquals("envelope-mismatch", issues.get(0).get("code"));
  }
}
