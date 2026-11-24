package com.scene.spatial.admin;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 验收-2 编辑请求的纯校验：坏请求必须在写库前被拒。 */
class ProductEditTest {

  @Test
  void declaredRequiresAllThreePositiveAxes() {
    final Map<String, Double> d = ProductEdit.declared(Map.of("w", 990, "d", 871.2, "h", 1980));
    assertEquals(990.0, d.get("w"));
    assertEquals(871.2, d.get("d"));
    assertEquals(1980.0, d.get("h"));

    assertThrows(IllegalArgumentException.class, () -> ProductEdit.declared(null));
    assertThrows(IllegalArgumentException.class, () -> ProductEdit.declared("990x871x1980"));
    assertThrows(IllegalArgumentException.class, () -> ProductEdit.declared(Map.of("w", 990, "d", 871)));
    assertThrows(IllegalArgumentException.class, () -> ProductEdit.declared(Map.of("w", 0, "d", 871, "h", 1980)));
    assertThrows(IllegalArgumentException.class, () -> ProductEdit.declared(Map.of("w", -1, "d", 871, "h", 1980)));
    assertThrows(IllegalArgumentException.class, () -> ProductEdit.declared(Map.of("w", "x", "d", 871, "h", 1980)));
  }

  @Test
  void thumbMustLiveUnderAssetsThumbs() {
    assertEquals("assets/thumbs/abc.png", ProductEdit.thumbFile(" assets/thumbs/abc.png "));
    assertEquals("", ProductEdit.thumbFile(null));
    assertThrows(IllegalArgumentException.class,
        () -> ProductEdit.thumbFile("assets/models/abc.png"));
    assertThrows(IllegalArgumentException.class,
        () -> ProductEdit.thumbFile("assets/thumbs/../secret.png"));
    assertThrows(IllegalArgumentException.class,
        () -> ProductEdit.thumbFile("assets/thumbs/sub/abc.png"));
  }

  @Test
  void hingeJsonMustBeAnArrayWhenGiven() {
    assertEquals(null, ProductEdit.hingeNodesJson(null));
    assertEquals("[]", ProductEdit.hingeNodesJson(List.of()));
    final String one = ProductEdit.hingeNodesJson(
        List.of(Map.of("node", "door", "axis", "y", "openAngleDeg", 106)));
    assertTrue(one.contains("door"));
    assertEquals(one, ProductEdit.hingeNodesJson(one));
    assertThrows(IllegalArgumentException.class, () -> ProductEdit.hingeNodesJson("not-json"));
    assertThrows(IllegalArgumentException.class, () -> ProductEdit.hingeNodesJson("{\"node\":\"door\"}"));
  }

  @Test
  void verifiedDoorMustBeOneOfTheFiveKinds() {
    assertEquals("single", ProductEdit.doorPart("single", true));
    assertEquals("drawer", ProductEdit.doorPart("drawer", true));
    // none = 已验证「整机一体 / 无可动件」，是**事实**，不是空值
    assertEquals("none", ProductEdit.doorPart("none", true));
    assertEquals("none", ProductEdit.doorPart(" NONE ", true), "大小写与空白不该决定身份");
    assertThrows(IllegalArgumentException.class, () -> ProductEdit.doorPart("", true));
    assertThrows(IllegalArgumentException.class, () -> ProductEdit.doorPart("柜门", true));
    assertEquals("", ProductEdit.doorPart(null, false));
  }

  @Test
  void sizeNoteIsRequiredOnEveryWritePath() {
    // 有模型也要写：size_note 是「声明尺寸从哪来、多可信」的唯一交代，不是无模型时的替代品
    assertEquals("官网图册估读，±20 mm", ProductEdit.sizeNote(" 官网图册估读，±20 mm "));
    assertThrows(IllegalArgumentException.class, () -> ProductEdit.sizeNote(null));
    assertThrows(IllegalArgumentException.class, () -> ProductEdit.sizeNote(""));
    assertThrows(IllegalArgumentException.class, () -> ProductEdit.sizeNote("   "));
  }
}
