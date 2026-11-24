package com.scene.spatial.api;

import jakarta.validation.constraints.Size;

import java.util.Map;

/** 参数配置的请求体（R6-4 B4a）。响应都是 Map —— 形状由 ParamsService 决定，不另开一堆类 */
public final class ParamsDtos {

  private ParamsDtos() {
  }

  /**
   * 发布一份补丁。
   *
   * `patch` 形如 `{"door": {"openOkDeg": 85}}`（与 `spatial-core` 的 `configure()` 同一个形状）——
   * **不另立一套"后台专用"格式**：多一套格式就多一处会与参数表脱节的地方。
   *
   * `note` 是给后来人看的（"为什么改"）。审计里留着它；不填也能发布（脚本要用），
   * 但界面会提示填 —— "上周四谁把门开度从 90 改成 85" 只答一半是没用的。
   */
  public record PublishRequest(
      Map<String, Object> patch,        // 分组名 → { 键: 值 }。外层用 Object 是因为里面是嵌套的 map
      @Size(max = 255) String note) {
  }
}
