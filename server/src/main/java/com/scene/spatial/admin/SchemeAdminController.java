package com.scene.spatial.admin;

import com.scene.spatial.kernel.Json;
import com.scene.spatial.scheme.SchemeService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * SchemeAdminController —— 维护端方案库（U1）
 *
 * 与设计端 `GET /api/schemes` 的分工（`docs/80` §四第 5 项）：
 *   设计端**只列当前账号的**（`owner_id` 等于会话用户）；这里列**全部账号的**，门是 `canMaintain`。
 *   `viewer` 在这一口被挡下（403），界面就按这个码显示「这一档看不到别人的方案」——
 *   给一个空列表的话，他会以为"方案库真的是空的"。
 *
 * 每一行在存储层给的行形状之上补两个字段：归属人的显示名、以及"那个账号还启用着吗"。
 * 认不出的 id **不编名字**：这一项缺席时界面回落到原始 id（维护端一贯的诚实口径）。
 */
@RestController
@RequestMapping("/api/admin/schemes")
public class SchemeAdminController {

  private final AdminService admin;
  private final SchemeService service;

  public SchemeAdminController(AdminService admin, SchemeService service) {
    this.admin = admin;
    this.service = service;
  }

  /**
   * 全部账号的方案。
   *
   * `deleted=true` 是回收站那一半（与设计端同一套语义）；`ownerId` 与 `q` 是筛选，
   * 都在服务层做（方案量级在几百，与 `docs/20` §6「v1 不做分页」一致）。
   */
  @GetMapping
  public Map<String, Object> list(
      @RequestParam(name = "deleted", defaultValue = "false") boolean deleted,
      @RequestParam(name = "ownerId", required = false) Long ownerId,
      @RequestParam(name = "q", required = false) String q) {
    admin.requireMaintain();
    final Map<String, String> names = admin.userNames();
    final Map<String, Boolean> enabled = admin.userEnabled();
    final List<Map<String, Object>> rows = new ArrayList<>();
    for (final Map<String, Object> row : service.listAll(deleted, ownerId, q)) {
      final Map<String, Object> out = new LinkedHashMap<>(row);
      final String owner = String.valueOf(row.get("ownerId"));
      final String name = names.get(owner);
      if (name != null) {
        out.put("ownerName", name);
      }
      final Boolean on = enabled.get(owner);
      if (on != null) {
        out.put("ownerEnabled", on);
      }
      rows.add(out);
    }
    return Json.obj("ok", true, "store", admin.storeMode(), "schemes", rows);
  }
}
