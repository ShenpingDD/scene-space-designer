package com.scene.spatial.admin;

import com.scene.spatial.kernel.Json;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * UserAdminController —— `/api/admin/users`（U1）
 *
 * 两道门的差别要写清楚（`docs/80` §五第 1 项）：
 *   **看列表**要 `canMaintain`（admin / editor —— `designer` 与 `viewer` 进不来）；
 *   **写**要 `canManageUsers`（只有 admin；建号、改角色、重置口令都是把权限交出去的动作）。
 *   于是 editor 能看见账号目录，却动不了任何账号。
 *
 * 字段校验全在 `UserAdminService` 里（一处口径）：控制器只接请求、过门、装响应。
 */
@RestController
@RequestMapping("/api/admin/users")
@ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
public class UserAdminController {

  private final UserAdminService service;
  private final AdminService admin;

  public UserAdminController(UserAdminService service, AdminService admin) {
    this.service = service;
    this.admin = admin;
  }

  /** 建号。`password` 可以不给 —— 那就建一个停用的号，口令之后再设 */
  public record CreateUser(String username, String displayName, String roleCode, String password,
      Boolean enabled) {
  }

  /** 改账号。三个字段都可以不给（不给就是"这次不改它"） */
  public record UpdateUser(String displayName, String roleCode, Boolean enabled) {
  }

  /** 设 / 重置口令 */
  public record SetPassword(String password) {
  }

  @GetMapping
  public Map<String, Object> list() {
    admin.requireMaintain();
    return Json.obj(
        "ok", true,
        "store", admin.storeMode(),
        "users", service.list(),
        // 四档的角色码随列表一起给：界面不自己抄一张对照表（改档位那天会改漏一边）
        "roles", AdminGate.ROLES);
  }

  @PostMapping
  public Map<String, Object> create(@RequestBody CreateUser req) {
    admin.requireManageUsers();
    return Json.obj("ok", true, "user", service.create(req.username(), req.displayName(),
        req.roleCode(), req.password(), req.enabled()));
  }

  @PatchMapping("/{id}")
  public Map<String, Object> update(@PathVariable long id, @RequestBody UpdateUser req) {
    admin.requireManageUsers();
    return Json.obj("ok", true, "user",
        service.update(id, req.displayName(), req.roleCode(), req.enabled()));
  }

  @PostMapping("/{id}/password")
  public Map<String, Object> setPassword(@PathVariable long id, @RequestBody SetPassword req) {
    admin.requireManageUsers();
    return Json.obj("ok", true, "user", service.resetPassword(id, req.password()));
  }

  @DeleteMapping("/{id}")
  public Map<String, Object> delete(@PathVariable long id) {
    admin.requireManageUsers();
    return service.delete(id);
  }
}
