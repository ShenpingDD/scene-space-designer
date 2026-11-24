package com.scene.spatial.admin;

import com.scene.spatial.kernel.Json;

import java.util.List;
import java.util.Map;

/**
 * ProductVisibility —— 「为什么设计端看不到这款产品」的**唯一判据**（P0，设计决策记录 §七）。
 *
 * 目录只返回 `status='active'` 的产品；维护端则要把 draft/disabled/LOD 失败都列出来。
 * 如果界面只显示一个状态，管理员会得到「这里明明有，设计端就是没有」的鬼故事 ——
 * 所以维护端卡片必须直接给 `frontVisible` + 一句可读的 `visibilityReason`。
 *
 * 判据（与目录实际取数对齐）：
 *   active + 默认变体 + 默认变体有 LOD0 产物 → 可见；
 *   其余逐条说明原因。**不放宽目录过滤**：这里只说「为什么不可见」，不把 draft 塞进目录。
 */
public final class ProductVisibility {

  private ProductVisibility() {}

  public static boolean visible(Map<String, Object> row) {
    return reason(row).isEmpty();
  }

  /** 空串 = 可见；否则是一句能直接给管理员看的原因（不静默） */
  public static String reason(Map<String, Object> row) {
    final String status = str(row.get("status"));
    if ("disabled".equals(status)) return "已停用：目录只返回 active";
    if (!"active".equals(status)) return "草稿（" + status + "）：未通过 LOD 激活，目录只返回 active";

    if (row.get("variant") == null && row.get("model_id") == null) {
      return "没有默认模型：目录需要 default 变体";
    }
    if (str(row.get("file_path")).isBlank()) {
      final String lodError = lodErrorOf(row.get("delta_vs_source_json"));
      return lodError.isBlank()
          ? "默认模型没有 LOD0 产物：LOD 未跑完"
          : "LOD 失败：" + lodError;
    }
    if (!hasLodLevel(row.get("lod_json"))) {
      return "LOD 未就绪：默认模型没有可用的 LOD 层级";
    }
    return "";
  }

  static boolean hasLodLevel(Object lodJson) {
    final String s = str(lodJson).trim();
    if (s.isEmpty() || "null".equals(s)) return false;
    try {
      final Object parsed = Json.parse(s);
      if (!(parsed instanceof Map<?, ?> m)) return false;
      final Object levels = m.get("levels");
      return levels instanceof List<?> list && !list.isEmpty();
    } catch (RuntimeException e) {
      return false;
    }
  }

  static String lodErrorOf(Object deltaJson) {
    final String s = str(deltaJson).trim();
    if (s.isEmpty() || "null".equals(s)) return "";
    try {
      final Object parsed = Json.parse(s);
      if (!(parsed instanceof Map<?, ?> m)) return "";
      final Object v = m.get("lodError");
      return v == null ? "" : String.valueOf(v);
    } catch (RuntimeException e) {
      return "";
    }
  }

  private static String str(Object o) {
    return o == null ? "" : String.valueOf(o);
  }
}
