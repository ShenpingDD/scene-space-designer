package com.scene.spatial.admin;

import com.scene.spatial.kernel.Json;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * ProductEdit —— 维护端「编辑产品」请求的纯校验（验收-2）。
 *
 * 为什么单独立一块：PUT 的错都在**写库之前**能判完（声明尺寸、门型、缩略图前缀、hinge JSON），
 * 放在 controller 里会与上传/读回混在一起；放在 repository 里则会让「坏请求」先碰库。
 * 这些方法全是 static 纯函数，测试不必起 Spring。
 */
final class ProductEdit {

  /**
   * 门型四选一 + 显式「没有门」。
   *
   * `none` 是**已验证的事实**（例如整机一体、无任何可动件），与空值（未确认）不是一回事：
   * 空值表示「不知道」，`none` 表示「知道没有」。把两者都当柜门是旧兜底，会凭空造出一扇门。
   */
  static final List<String> DOOR_PARTS = List.of("single", "double", "top", "drawer", "none");
  private static final String THUMB_PREFIX = "assets/thumbs/";

  private ProductEdit() {}

  /** 声明尺寸：三轴齐全、有限、>0；返回固定顺序 w/d/h。 */
  static Map<String, Double> declared(Object raw) {
    if (!(raw instanceof Map<?, ?> m)) {
      throw new IllegalArgumentException("缺 declared：声明尺寸要三轴齐全（w/d/h，单位 mm）");
    }
    final Map<String, Double> out = new LinkedHashMap<>();
    for (final String k : List.of("w", "d", "h")) {
      final Double v = positive(m.get(k), "declared." + k);
      out.put(k, v);
    }
    return out;
  }

  /** 单轴正数；非法值直接说清是哪一轴、收到什么。 */
  static double positive(Object raw, String field) {
    final Double v;
    if (raw instanceof Number n) {
      v = n.doubleValue();
    } else {
      try {
        v = raw == null ? null : Double.valueOf(String.valueOf(raw).trim());
      } catch (NumberFormatException e) {
        throw new IllegalArgumentException(field + " 必须是数字（收到：" + raw + "）");
      }
    }
    if (v == null || !Double.isFinite(v) || v <= 0) {
      throw new IllegalArgumentException(field + " 必须大于 0（收到：" + raw + "）");
    }
    return v;
  }

  /** 缩略图只许 assets/thumbs/ 下的文件名；空串表示清空。 */
  static String thumbFile(Object raw) {
    final String s = raw == null ? "" : String.valueOf(raw).trim();
    if (s.isEmpty()) return "";
    if (!s.startsWith(THUMB_PREFIX)) {
      throw new IllegalArgumentException("thumbFile 只允许 " + THUMB_PREFIX + " 前缀（收到：" + s + "）");
    }
    final String name = s.substring(THUMB_PREFIX.length());
    if (name.isEmpty() || name.contains("..") || name.contains("/") || name.contains("\\")) {
      throw new IllegalArgumentException("thumbFile 必须是 " + THUMB_PREFIX + " 下的单层文件名（收到：" + s + "）");
    }
    return s;
  }

  /** 门型：doorVerified=1 时必须五选一（含 none）；未确认时允许空/旧值。 */
  static String doorPart(Object rawPart, boolean verified) {
    final String part = rawPart == null ? "" : String.valueOf(rawPart).trim().toLowerCase(java.util.Locale.ROOT);
    if (verified && !DOOR_PARTS.contains(part)) {
      throw new IllegalArgumentException("doorVerified=1 时 doorPart 必须是 "
          + String.join(" / ", DOOR_PARTS) + "（收到：" + (part.isEmpty() ? "(空)" : part) + "）");
    }
    return part;
  }

  /**
   * 尺寸说明（size_note）：有模型的产品必须写。
   *
   * 为什么不再允许空着：envelope_ok 是「声明 vs 实测」的对账结论，声明来自 recipe_json；
   * 而 recipe_json 的数字从哪来、可信到什么程度，只有 size_note 说得清。空着就等于
   * 「这两组数是不是一回事，没人负责」—— 用户 22:18 记的演示产品缺陷正是这一类。
   *
   * 白名单形状的旧文案（「待核实」「官网图册估读」）照旧接受，只是不许空。
   */
  static String sizeNote(Object raw) {
    final String s = str(raw);
    if (s.isEmpty()) {
      throw new IllegalArgumentException(
          "sizeNote 不能为空：有模型的产品也要写清声明尺寸从哪来、可信到什么程度（例：官网图册估读，±20 mm）");
    }
    return s;
  }

  /**
   * hingeNodesJson：null = 不改；字符串必须是 JSON 数组；也接受前端直接给数组。
   * 返回可写库的 JSON 文本，坏 JSON 在写库前被拒。
   */
  static String hingeNodesJson(Object raw) {
    if (raw == null) return null;
    if (raw instanceof List<?> list) return Json.write(list, 0);
    final String s = String.valueOf(raw).trim();
    if (s.isEmpty()) return null;
    final Object parsed;
    try {
      parsed = Json.parse(s);
    } catch (RuntimeException e) {
      throw new IllegalArgumentException("hingeNodesJson 不是合法 JSON：" + e.getMessage());
    }
    if (!(parsed instanceof List<?> list)) {
      throw new IllegalArgumentException("hingeNodesJson 必须是 JSON 数组");
    }
    return Json.write(list, 0);
  }

  /** true / 1 / "1" / "true" 都认；其余按 false。 */
  static boolean bool(Object raw) {
    if (raw instanceof Boolean b) return b;
    if (raw instanceof Number n) return n.intValue() != 0;
    final String s = raw == null ? "" : String.valueOf(raw).trim();
    return "1".equals(s) || "true".equalsIgnoreCase(s);
  }

  static String str(Object raw) {
    return raw == null ? "" : String.valueOf(raw).trim();
  }
}
