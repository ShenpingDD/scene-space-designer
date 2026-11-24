package com.scene.spatial.kernel;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Doors.java —— 规则 4：门语义
 *
 * 移植自 `spatial-core/src/doors.js`（原型 `setDoorAmount()` / `applyDoorAmount()` 与模型工厂 `setDoor()`）。
 *
 * 搬运时合并了一处**重复实现**：`rotation[axis] = openAngle × amount`
 * 原本在主脚本和模型工厂各写了一遍 —— 两份迟早漂移。现在全项目只有这一份，
 * 用例 `door-hinge-formula`（openAngle 1.85 × amount 0.5 = 0.925）就是它的判据。
 */
public final class Doors {

  private Doors() {
  }

  /** 当前模型缺少门体节点时给用户的原话 */
  public static final String NO_HINGES = "当前模型缺少门体节点，请更新开门版模型";

  /** 门能不能开：模型是否带铰链（原型 `currentModel.hinges.length > 0`，散落两处 → FIX-12） */
  public static boolean canOpen(java.util.List<?> hinges) {
    return hinges != null && !hinges.isEmpty();
  }

  /** 开度夹取到 [amountMin, amountMax]；非有限数一律当 0（不许 NaN 流进模型） */
  public static double clampDoorAmount(double v) {
    if (!Double.isFinite(v)) return 0;
    return Math.max(ParamsLive.p().doorAmountMin, Math.min(ParamsLive.p().doorAmountMax, v));
  }

  public static boolean isDoorOpen(double amount) {
    return amount > 0;
  }

  /**
   * 铰链旋转量：`rotation[axis] = openAngle × amount` —— **全项目唯一的公式**。
   *
   * 返回 `{axis: 弧度}`（用 Map 而不是自建类型：3D 层直接按轴名取值，与 JS 形状一致）。
   */
  public static Map<String, Object> hingeRotation(String axis, double openAngle, double amount) {
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put(axis, openAngle * clampDoorAmount(amount));
    return out;
  }

  /** 门型代码 → 中文文案（与 `spatial-core/src/doors.js` 同表 —— 改一处必须改两处） */
  private static final Map<String, String> DOOR_PART_LABELS = Map.of(
      "single", "柜门",
      "double", "双门",
      "top", "上盖",
      "drawer", "抽屉",
      // none = **已验证的事实**（整机一体 / 无可动件），与空值（未确认）不是一回事
      "none", "无门");

  /**
   * 部位文案。参数是**门型代码**（`product.door_part`），**不是产品 id** ——
   * 以前按型号名写死（demo-freezer-chest→上盖），那是"同一件事两处说"；现在真相只住在那一列。
   * 过渡期：认不出的值原样显示（老库里可能还是中文）。
   *
   * ⚠️ 空值不再兜底「柜门」：**没填 ≠ 没有门，也不等于柜门**。旧兜底会凭空造出一扇门，
   * 让「门型未确认」的产品看起来像有柜门。空值如实说「未确认」；确无门时数据里写 none。
   */
  public static String doorPartLabel(String part) {
    String raw = part == null ? "" : part.trim();
    String hit = DOOR_PART_LABELS.get(raw);
    if (hit != null) return hit;
    if (!raw.isEmpty()) return raw;
    return "未确认";
  }

  /** 按钮文案：打开/关闭 + 部位 */
  public static String doorButtonLabel(String part, double amount) {
    return (isDoorOpen(amount) ? "关闭" : "打开") + doorPartLabel(part);
  }

  /** 状态文案（原型 `doorState`） */
  public static String doorStateText(double amount) {
    final double a = clampDoorAmount(amount);
    return a == 0 ? "已关闭" : "已打开 " + Math.round(a * 100) + "%";
  }

  /** 把门开度写进方案（就地修改，返回被改的那台；与 {@link Placement} 同款取舍） */
  public static Layout.Item setDoorAmount(Layout layout, int itemId, double amount) {
    final double a = clampDoorAmount(amount);
    Layout.Item changed = null;
    for (int k = 0; k < layout.items.size(); k++) {
      final Layout.Item i = layout.items.get(k);
      if (i.id != itemId) continue;
      changed = new Layout.Item(i.id, i.p, i.x, i.z, i.r, a);
      layout.items.set(k, changed);
    }
    return changed;
  }
}