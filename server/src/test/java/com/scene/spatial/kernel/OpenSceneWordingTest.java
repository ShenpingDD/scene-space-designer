package com.scene.spatial.kernel;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.scene.spatial.scheme.Delivery;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * OpenSceneWordingTest —— W3：交付清单上「开放场景」与「未分房间」是**两句话**。
 *
 * 背景（docs/91 §五、docs/93 §6）：开放场景是"这片场地没有被墙围成房间"，
 * 未分房间是"真的不知道这台归哪一间"（客户端没算、墙太厚算不出来等）。
 * 合成一句会把**正常结果**说成**漏算**，用户会去查一个不存在的 bug。
 *
 * ⚠️ 服务端**不重算**开放面：房间列的值由客户端递进来（面遍历只在 JS 内核里有一份）。
 *    这里钉的是**服务端如实写、不猜、也不把两个词混用**这一件事。
 */
class OpenSceneWordingTest {

  /** 题目里的四个字必须逐字一致（与 `spatial-core` 的 `OPEN_SCENE` 同一个词，两侧都按字面量钉） */
  private static final String OPEN_SCENE_WORD = "开放场景";
  private static final String NO_ROOM_WORD = "未分房间";

  private static Map<String, Object> item(String p, double x, double z, int id) {
    final Map<String, Object> i = new LinkedHashMap<>();
    i.put("p", p);
    i.put("x", x);
    i.put("z", z);
    i.put("r", 0.0);
    i.put("id", id);
    i.put("doorAmount", 0.0);
    return i;
  }

  private static Map<String, Object> product(String model, String name) {
    final Map<String, Object> p = new LinkedHashMap<>();
    p.put("model", model);
    p.put("name", name);
    p.put("w", 0.86);
    p.put("d", 0.99);
    p.put("h", 1.99);
    p.put("sizeNote", "");
    p.put("file", "");
    return p;
  }

  private static Map<String, Object> state() {
    final Map<String, Object> s = new LinkedHashMap<>();
    s.put("w", 10.0);
    s.put("d", 8.0);
    s.put("h", 2.8);
    s.put("walls", List.of());
    s.put("items", List.of(
        item("demo-cabinet-800", 0.7, 0.7, 1),
        item("demo-cabinet-800", 4.5, 1.2, 2),
        item("demo-cabinet-800", 8.0, 6.0, 3)));
    return s;
  }

  private static Map<String, Map<String, Object>> catalog() {
    final Map<String, Map<String, Object>> by = new LinkedHashMap<>();
    by.put("demo-cabinet-800", product("DEMO-CT-100", "超低温保存箱, 立式"));
    return by;
  }

  private static String csv(Map<String, String> rooms) {
    return new String(Delivery.csv(state(), catalog(), rooms), StandardCharsets.UTF_8);
  }

  @Test
  @DisplayName("常量与词面：开放场景 / 未分房间 是两个字面量且不相等（合成就把正常结果说成漏算）")
  void wordsAreDistinct() {
    assertEquals(OPEN_SCENE_WORD, Delivery.OPEN_SCENE, "开放场景的说法要和内核同一个词");
    assertEquals(NO_ROOM_WORD, Delivery.NO_ROOM, "未分房间的说法不许改（M1 已交付过）");
    assertFalse(OPEN_SCENE_WORD.equals(NO_ROOM_WORD));
  }

  @Test
  @DisplayName("设备清单.csv：开放场景原样写「开放场景」，缺项仍写「未分房间」—— 两者同表可辨")
  void csvKeepsOpenSceneAndUnknownApart() {
    final Map<String, String> rooms = new LinkedHashMap<>();
    rooms.put("1", "冰箱间");
    rooms.put("2", OPEN_SCENE_WORD);
    // 3 不递 → 真的不知道，如实写未分房间（不猜成开放场景）
    final String csv = csv(rooms);
    assertTrue(csv.contains("冰箱间; " + OPEN_SCENE_WORD + "; " + NO_ROOM_WORD),
        "同一台型号的三处位置：房间 / 开放场景 / 未分房间 要能一眼分辨：" + csv);
    assertEquals(OPEN_SCENE_WORD, Delivery.roomCell(OPEN_SCENE_WORD), "开放场景原样写，不许替换");
    assertEquals(NO_ROOM_WORD, Delivery.roomCell(null), "缺项写未分房间");
    assertEquals(NO_ROOM_WORD, Delivery.roomCell("  "), "空白也写未分房间（空格子会被当成漏画了）");
  }
}