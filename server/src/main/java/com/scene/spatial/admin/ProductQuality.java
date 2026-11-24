package com.scene.spatial.admin;

import com.scene.spatial.kernel.Params;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * ProductQuality —— 产品级质量闸门（BLOCK / WARN 两层）
 *
 * 为什么要有这一层：维护端角标（{@link AdminBadges}）回答的是「这张卡上该不该挂个黄条」，
 * 而**能不能让产品上岗**（LOD 跑完转 active）是另一个问题。两者共用同一批判据，但不能共用
 * 同一个返回值 —— 一条「非供应商交付」的黄条不该挡住一款能用的产品，而「声明尺寸根本没填」
 * 这种数据缺口如果也当黄条放过去，前台就会按一个不存在的包络摆它。
 *
 * 分层口径（本类只有这一份，controller / repository / 角标都读它）：
 *
 *   BLOCK —— 数据缺口大到「判不了、也不能用」：声明尺寸（recipe w/d/h）缺失或非正、
 *            模型行单位缺失或不是 mm、门型为空（没填 ≠ 没有门）、尺寸说明为空。
 *            **没有实测数据不算 BLOCK**（那是「未判」，见下）。
 *   WARN  —— 判了但不理想，或**有数据却判不了**：1:1 对账不通过（envelope_ok=0）、
 *            1:1 没有实测包围盒（尺寸未判 → envelope_ok=NULL）、门型未确认（door_verified=0）。
 *            （`size_note` 为空**不在这里** —— 它是 BLOCK，见上。存量 active 不追溯强改，
 *            但 `GET /quality` 会把它列出来、`POST /quality/recheck` 不会替它编一句说明。）
 *
 * ⚠️ 三条刻意不 BLOCK 的事（都有测试钉住，别好心改坏）：
 *   ① `envelope_ok=0`（实测与声明不符）—— 它是**结论**，要让人看见并决定怎么办，不是数据坏；
 *   ② `door_verified=0`（门型未确认）—— 未知 ≠ 错误，规则 7 的净空体检会自己说「算不准」；
 *   ③ fit 模式下的 `envelope_ok=0` —— fit 是刻意缩放，声明与实测本来就不同。
 *   门型为空 / 尺寸说明为空则是**数据缺口**，必须 BLOCK：两者都拦在「激活」之前，
 *   而不是等前台按一扇并不存在的门摆位、或按一个没人负责的包络摆位。
 *
 * 纯函数：输入一行（库里的 snake_case 列名），输出一条结论；不起 Spring、不碰数据库。
 */
public final class ProductQuality {

  private ProductQuality() {
  }

  /** 挡住上岗：数据缺口（声明尺寸/单位），不是「结论为否」 */
  public static final String BLOCK = "block";
  /** 可以上岗，但必须看得见 */
  public static final String WARN = "warn";
  /** 没有发现 */
  public static final String OK = "ok";

  /** 声明尺寸与实测包围盒逐轴比较的容差（mm）—— **唯一出处是参数表**，不许在这里写死第二份 */
  public static int tolMm() {
    return Params.modelEnvelopeTolMm;
  }

  /** 一条判据。`code` 是给机器/测试认的稳定标识，`message` 是给人看的中文原话。 */
  public record Issue(String level, String code, String message) {
    public Map<String, Object> toMap() {
      final Map<String, Object> m = new LinkedHashMap<>();
      m.put("level", level);
      m.put("code", code);
      m.put("message", message);
      return m;
    }
  }

  /**
   * 一次质量检查的结论。
   *
   * `blocked()` 才是「能不能上岗」的唯一判据；`warnCount()` 只影响展示，永远不该被当成失败。
   */
  public record Gate(List<Issue> issues) {

    public boolean blocked() {
      for (final Issue i : issues) {
        if (BLOCK.equals(i.level())) return true;
      }
      return false;
    }

    public List<Issue> blocks() {
      final List<Issue> out = new ArrayList<>();
      for (final Issue i : issues) if (BLOCK.equals(i.level())) out.add(i);
      return out;
    }

    public List<Issue> warnings() {
      final List<Issue> out = new ArrayList<>();
      for (final Issue i : issues) if (WARN.equals(i.level())) out.add(i);
      return out;
    }

    public int blockCount() {
      return blocks().size();
    }

    public int warnCount() {
      return warnings().size();
    }

    /** 总层：有 BLOCK 就是 block，只有 WARN 就是 warn，什么都没有才是 ok */
    public String level() {
      if (blocked()) return BLOCK;
      return warnCount() > 0 ? WARN : OK;
    }

    /** 一句话结论（审计/日志/接口都用它，不再各拼一份） */
    public String summary() {
      if (issues.isEmpty()) return "质量闸门：无问题";
      final List<String> parts = new ArrayList<>();
      for (final Issue i : issues) {
        parts.add((BLOCK.equals(i.level()) ? "BLOCK " : "WARN ") + i.message());
      }
      return "质量闸门：" + String.join("；", parts);
    }

    /** 接口形状：QA 只看这几个字段也能复核（level / blocked / 逐条 issues） */
    public Map<String, Object> toMap() {
      final Map<String, Object> out = new LinkedHashMap<>();
      out.put("level", level());
      out.put("blocked", blocked());
      out.put("blockCount", blockCount());
      out.put("warnCount", warnCount());
      final List<Object> all = new ArrayList<>();
      for (final Issue i : issues) all.add(i.toMap());
      out.put("issues", all);
      out.put("summary", summary());
      return out;
    }
  }

  /**
   * 按一行产品（产品列 + 默认变体的模型列）算闸门。
   *
   * 认的列名与 `AdminRepository.PRODUCT_ROW_SELECT` 一致（snake_case）：
   * `recipe_json / file_path / unit / bbox_w|d|h / envelope_mode / envelope_ok /
   *  door_part / door_verified / size_note`。
   * 也接受 `declaredW/D/H` 三个已解析好的键（编辑路径用），免得再解析一遍 recipe_json。
   */
  public static Gate gate(Map<String, Object> row) {
    final List<Issue> issues = new ArrayList<>();
    final boolean hasModel = !blank(row.get("file_path"));

    final Double dW = declared(row, "w");
    final Double dD = declared(row, "d");
    final Double dH = declared(row, "h");
    if (dW == null || dD == null || dH == null) {
      issues.add(new Issue(BLOCK, "declared-missing",
          "声明尺寸（recipe_json 的 w/d/h）缺失或非法 —— 没有它既摆不进方案，也无从对账；"
              + "「未判」是好数据缺读数，这是数据本身缺了"));
    }

    if (hasModel) {
      final String unit = str(row.get("unit"));
      if (unit.isEmpty()) {
        issues.add(new Issue(BLOCK, "unit-missing",
            "模型行没有单位（unit）—— 全场景按 mm 换算，单位不明就无法判断这些数是 mm 还是 m"));
      } else if (!"mm".equals(unit)) {
        issues.add(new Issue(BLOCK, "unit-not-mm",
            "模型行单位是「" + unit + "」而不是 mm —— 全场景按 mm 换算，非 mm 的尺寸不可用"));
      }
    }

    final Double bW = number(row.get("bbox_w"));
    final Double bD = number(row.get("bbox_d"));
    final Double bH = number(row.get("bbox_h"));
    final String mode = str(row.get("envelope_mode"));

    if (hasModel && (bW == null || bD == null || bH == null)) {
      // 「没读数」不是「判为否」—— 这里只 WARN，并把 envelope_ok 留 NULL（见 envelopeOk）
      issues.add(new Issue(WARN, "envelope-unmeasured",
          "实测包围盒缺失 → 尺寸未判（没有可核对的实测数据；补齐 bbox_w/d/h 或重导入模型后会自动判）"));
    } else if ("1:1".equals(mode)) {
      final Integer ok = envelopeOk(mode, dW, dD, dH, bW, bD, bH);
      if (ok == null) {
        issues.add(new Issue(WARN, "envelope-unjudged",
            "尺寸未判（1:1 但缺声明尺寸或实测包围盒）—— 声明与实测是否一致，现在答不上来"));
      } else if (ok == 0) {
        // 结论为否只 WARN：envelope_ok=0 是「实测与声明不符」这个事实，不是数据坏到不能用
        issues.add(new Issue(WARN, "envelope-mismatch",
            "尺寸未对账（1:1 逐轴容差 " + tolMm() + " mm）：" + axesText(row)));
      }
    }

    final String doorPart = str(row.get("door_part"));
    if (doorPart.isEmpty()) {
      // 空值 ≠ 没有门。旧口径把「没填」当成「柜门」兜底，于是凭空造出一扇门；
      // 这里把它当**数据缺口**卡住：要么写真实门型，要么显式写 none。
      issues.add(new Issue(BLOCK, "door-missing",
          "门型（door_part）为空 —— 没填 ≠ 没有门：请填写 single / double / top / drawer / none；"
              + "确无任何可动件时显式写 none 并置 door_verified=1"));
    } else if (!truthy(row.get("door_verified")) && !"none".equals(doorPart)) {
      issues.add(new Issue(WARN, "door-unverified",
          "门型未确认（这不是「没有门」；确认后把 door_verified 置 1）"
              + "—— 规则 7 的开门净空体检会算不准"));
    }

    if (blank(row.get("size_note"))) {
      // 尺寸说明是声明尺寸的「从哪来、多可信」——没有它就没人为这两组数字负责。
      issues.add(new Issue(BLOCK, "size-note-missing",
          "尺寸说明（size_note）为空 —— 声明尺寸是从哪来的、可信到什么程度没有交代；"
              + "新建与激活都必须写（存量 active 不追溯改，但质检会指出来）"));
    }

    return new Gate(issues);
  }

  /**
   * 1:1 尺寸对账：**逐轴**比较声明包络与实测包围盒，不取平均、不取比值。
   *
   * 返回三态：
   *   1    三轴都在容差内；
   *   0    至少一轴超出容差（逐轴判，某一轴差得多不会被别的轴的接近平均掉）；
   *   null 无法判（mode 不是 1:1，或任一侧有轴缺失/非有限数）。
   *
   * ⚠️ NULL 只许表示「确实没有可核对的数据」，不许因为「懒得算」而返回 null。
   */
  public static Integer envelopeOk(Object mode, Object declaredW, Object declaredD, Object declaredH,
                                   Object bboxW, Object bboxD, Object bboxH) {
    if (!"1:1".equals(str(mode))) return null;   // fit/空：这一列对它没有意义
    final Double dW = number(declaredW);
    final Double dD = number(declaredD);
    final Double dH = number(declaredH);
    final Double bW = number(bboxW);
    final Double bD = number(bboxD);
    final Double bH = number(bboxH);
    if (dW == null || dD == null || dH == null || bW == null || bD == null || bH == null) {
      return null;
    }
    final double tol = tolMm();
    return Math.abs(dW - bW) <= tol && Math.abs(dD - bD) <= tol && Math.abs(dH - bH) <= tol ? 1 : 0;
  }

  /**
   * 逐轴读数（给 QA 的复核字段）：每一轴的声明值、实测值、差值、是否在容差内。
   *
   * 返回空列表 = 数据不足，画不出这张表；**不要用空列表冒充「三轴都对」**。
   */
  public static List<Map<String, Object>> envelopeAxes(Object declaredW, Object declaredD, Object declaredH,
                                                       Object bboxW, Object bboxD, Object bboxH) {
    final Double[] declared = {number(declaredW), number(declaredD), number(declaredH)};
    final Double[] measured = {number(bboxW), number(bboxD), number(bboxH)};
    final String[] names = {"w", "d", "h"};
    final List<Map<String, Object>> out = new ArrayList<>();
    for (int i = 0; i < 3; i++) {
      if (declared[i] == null || measured[i] == null) continue;
      final Map<String, Object> a = new LinkedHashMap<>();
      a.put("axis", names[i]);
      a.put("declaredMm", declared[i]);
      a.put("measuredMm", measured[i]);
      a.put("deltaMm", round(measured[i] - declared[i]));
      a.put("tolMm", tolMm());
      a.put("ok", Math.abs(measured[i] - declared[i]) <= tolMm());
      out.add(a);
    }
    return out;
  }

  /** 逐轴读数的中文摘要（「尺寸未对账」那句 why 用它，避免两处各写一遍阈值） */
  public static String axesText(Map<String, Object> row) {
    final List<Map<String, Object>> axes = envelopeAxes(
        declared(row, "w"), declared(row, "d"), declared(row, "h"),
        row.get("bbox_w"), row.get("bbox_d"), row.get("bbox_h"));
    if (axes.isEmpty()) return "（数据不足，画不出逐轴读数）";
    final List<String> parts = new ArrayList<>();
    for (final Map<String, Object> a : axes) {
      parts.add(a.get("axis") + " 声明 " + a.get("declaredMm") + " / 实测 " + a.get("measuredMm")
          + (Boolean.TRUE.equals(a.get("ok")) ? "（在容差内）" : "（差 " + a.get("deltaMm") + " mm）"));
    }
    return String.join("，", parts);
  }

  // ── 小工具 ────────────────────────────────────────────────────────────

  /** 声明尺寸：优先读已解析的 `declaredW/D/H`，否则从 recipe_json 文本里取（与 ProductDraft.numOf 同一读法） */
  private static Double declared(Map<String, Object> row, String axis) {
    final String key = "declared" + axis.toUpperCase();
    if (row != null && row.containsKey(key)) return number(row.get(key));
    final String recipe = row == null ? "" : str(row.get("recipe_json"));
    if (recipe.isEmpty()) return null;
    final Double v = ProductDraft.numOf(recipe, axis);
    return v == null || !Double.isFinite(v) || v <= 0 ? null : v;
  }

  private static Double number(Object o) {
    final Double v;
    if (o instanceof Number n) {
      v = n.doubleValue();
    } else {
      final String s = str(o);
      if (s.isEmpty()) return null;
      try {
        v = Double.valueOf(s);
      } catch (NumberFormatException e) {
        return null;
      }
    }
    return v != null && Double.isFinite(v) ? v : null;
  }

  private static double round(double v) {
    return Math.round(v * 1000.0) / 1000.0;
  }

  private static String str(Object o) {
    return o == null ? "" : String.valueOf(o).trim();
  }

  private static boolean blank(Object o) {
    return str(o).isEmpty();
  }

  private static boolean truthy(Object o) {
    if (o == null) return false;
    if (o instanceof Boolean b) return b;
    if (o instanceof Number n) return n.intValue() != 0;
    final String s = str(o);
    return "1".equals(s) || "true".equalsIgnoreCase(s);
  }
}
