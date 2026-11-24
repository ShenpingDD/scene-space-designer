package com.scene.spatial.admin;

import com.scene.spatial.api.ApiProblem;
import com.scene.spatial.auth.CurrentUser;
import com.scene.spatial.kernel.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * UserAdminService —— 账号的增删改查（U1）
 *
 * 规则都写在这一层，控制器只做三件事：接请求、过角色门、把行装成响应。
 *
 * ## 三条取舍
 *
 * 第 1 条，**登录名限 2 到 32 位、只用英文字母数字与 `._-`**。两个原因都要说出来：
 *   它会进 `bash tools/server/set-password.sh <username>` 这条命令行（特殊字符会很危险），
 *   也会进 `audit_log.actor`（那一列是 `VARCHAR(32)`）。
 *
 * 第 2 条，**没有口令的账号一定是停用的**。占位散列登不进来（`BCryptPasswordEncoder.matches`
 *   回 false），此时回 `enabled: true` 就是一句谎话 —— 界面会显示"启用中"而人登不进来。
 *
 * 第 3 条，**自己不能停用自己、不能删除自己；最后一名启用着的管理员不能被降级、停用、删除**。
 *   前者防的是手一滑把自己关在门外，后者防的是这条路走完之后**再没有人能管用户**。
 */
@Service
@ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
public class UserAdminService {

  private static final Logger log = LoggerFactory.getLogger(UserAdminService.class);

  /** 登录名：字母或数字开头，之后允许 `._-`，总长 2 到 32 */
  private static final Pattern USERNAME = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{1,31}");

  private static final int DISPLAY_MIN = 1;
  private static final int DISPLAY_MAX = 32;
  private static final int PASSWORD_MIN = 8;
  /** BCrypt 只取前 72 个字节，再长的口令不会更强 —— 上限照它定，免得给人"越长越安全"的错觉 */
  private static final int PASSWORD_MAX_BYTES = 72;

  /** 还没设过口令的占位值。以 `!` 开头是各家框架通行的"不是有效散列"约定（与 `V4` 那行同口径） */
  public static final String NO_PASSWORD = "!no-password";

  /** `audit_log.target_type` 的取值（与 设计决策记录的"某对象的历史"同口径） */
  public static final String TARGET_USER = "user";

  private final UserWriteRepository writes;
  private final CurrentUser currentUser;
  private final PasswordEncoder encoder;
  private final AuditLog audit;

  public UserAdminService(UserWriteRepository writes, CurrentUser currentUser,
      PasswordEncoder encoder, AuditLog audit) {
    this.writes = writes;
    this.currentUser = currentUser;
    this.encoder = encoder;
    this.audit = audit;
  }

  // ── 读 ────────────────────────────────────────────────────────────────

  /** 账号列表（含停用）。`schemeCount` 一次取回，免得列表变成 N+1 次查询 */
  public List<Map<String, Object>> list() {
    final Map<String, Long> schemeCounts = writes.schemeCountByOwner();
    final List<Map<String, Object>> out = new ArrayList<>();
    for (final Map<String, Object> row : writes.users()) {
      out.add(view(row, schemeCounts));
    }
    return out;
  }

  // ── 写 ────────────────────────────────────────────────────────────────

  /** 建号。给了口令就按请求的启用状态（默认启用）；没给口令就停用，并如实回 `passwordSet: false` */
  public Map<String, Object> create(String usernameRaw, String displayNameRaw, String roleRaw,
      String passwordRaw, Boolean enabledRequested) {
    final String username = requireUsername(usernameRaw);
    final String displayName = requireDisplayName(displayNameRaw);
    final String roleCode = requireRole(roleRaw);
    final boolean hasPassword = passwordRaw != null && !passwordRaw.isEmpty();
    final String hash = hasPassword ? encoder.encode(requirePassword(passwordRaw)) : NO_PASSWORD;
    final boolean enabled = hasPassword && (enabledRequested == null || enabledRequested);
    if (writes.countByUsername(username) > 0) {
      throw ApiProblem.conflict("登录名「" + username + "」已经有了：换一个（显示名可以随便改，登录名是身份）");
    }
    final long id;
    try {
      id = writes.insertUser(username, hash, displayName, roleCode, enabled);
    } catch (DuplicateKeyException e) {
      // 并发窗口里另一个人刚插了同一个登录名 —— 唯一键是最后一道，翻成同一句话
      throw ApiProblem.conflict("登录名「" + username + "」已经有了：换一个");
    }
    audit.write(currentUser.username(), "create", TARGET_USER, String.valueOf(id),
        Json.write(Json.obj("username", username, "roleCode", roleCode, "enabled", enabled,
            "passwordSet", hasPassword), 0));
    log.info("建号：{}（角色 {}，启用 {}）", username, roleCode, enabled);
    return view(writes.userById(id), writes.schemeCountByOwner());
  }

  /** 改显示名 / 角色 / 启用状态。没给的字段保持原值（`null` 就是"这次不改它"） */
  public Map<String, Object> update(long id, String displayNameRaw, String roleRaw,
      Boolean enabledRequested) {
    final Map<String, Object> before = require(id);
    final String beforeRole = AdminGate.normalize(str(before.get("role_code")));
    final boolean beforeEnabled = AdminGate.enabled(before.get("enabled"));
    final String displayName = displayNameRaw == null
        ? str(before.get("display_name")) : requireDisplayName(displayNameRaw);
    final String roleCode = roleRaw == null ? beforeRole : requireRole(roleRaw);
    final boolean enabled = enabledRequested == null ? beforeEnabled : enabledRequested;
    if (id == currentUser.id() && beforeEnabled && !enabled) {
      throw ApiProblem.selfLockout("不能停用自己：你现在就登在这个号上，停用之后谁也进不来（让另一名管理员来停）");
    }
    guardLastAdmin(id, beforeRole, beforeEnabled, roleCode, enabled);
    writes.updateUser(id, displayName, roleCode, enabled);
    audit.write(currentUser.username(), enabled ? "update" : "disable", TARGET_USER, String.valueOf(id),
        Json.write(Json.obj("roleCode", roleCode, "enabled", enabled), 0));
    return view(writes.userById(id), writes.schemeCountByOwner());
  }

  /** 设 / 重置口令。**不动启用状态**：启用与停用是另一条动作，两件事分开做才不会互相盖掉 */
  public Map<String, Object> resetPassword(long id, String passwordRaw) {
    final Map<String, Object> before = require(id);
    final boolean firstTime = !passwordSet(before.get("password_hash"));
    writes.updatePassword(id, encoder.encode(requirePassword(passwordRaw)));
    // 口令本身**不进** detail_json：audit_log 只用来事后说得清，不放口令
    audit.write(currentUser.username(), "password", TARGET_USER, String.valueOf(id),
        Json.write(Json.obj("firstTime", firstTime), 0));
    log.info("设口令：{}（第一次设：{}）", str(before.get("username")), firstTime);
    return view(writes.userById(id), writes.schemeCountByOwner());
  }

  /**
   * 物理删除。只有**一条引用都没有**时才允许 —— 与"产品只停用不删除"那条既有拍板同一个考虑：
   * 删掉一个还有方案挂在他名下的账号，会让那些方案变成没人认领的孤儿。
   */
  public Map<String, Object> delete(long id) {
    final Map<String, Object> before = require(id);
    if (id == currentUser.id()) {
      throw ApiProblem.selfLockout("不能删除自己：让另一名管理员来删（他删之前会被要求先接手你的方案）");
    }
    guardLastAdmin(id, AdminGate.normalize(str(before.get("role_code"))),
        AdminGate.enabled(before.get("enabled")), "", false);
    final Map<String, Object> counts = inUseCounts(id);
    if (anyPositive(counts)) {
      throw ApiProblem.userInUse(counts, inUseMessage(counts));
    }
    try {
      writes.deleteUser(id);
    } catch (DataIntegrityViolationException e) {
      // 刚数完到真删之间又有人挂了引用（并发窗口）：外键挡住，翻成同一句话再报一次
      final Map<String, Object> again = inUseCounts(id);
      throw ApiProblem.userInUse(again, inUseMessage(again));
    }
    audit.write(currentUser.username(), "delete", TARGET_USER, String.valueOf(id),
        Json.write(Json.obj("username", str(before.get("username"))), 0));
    log.info("删号：{}", str(before.get("username")));
    return Json.obj("ok", true, "deleted", true, "id", id, "username", str(before.get("username")));
  }

  // ── 规则（纯函数，能被单测直接钉住） ─────────────────────────────────────

  /** 登录名。长度上限同时保证它能进 `audit_log.actor`（`VARCHAR(32)`）与那一条命令行 */
  public static String requireUsername(String raw) {
    final String value = raw == null ? "" : raw.trim();
    if (!USERNAME.matcher(value).matches()) {
      throw ApiProblem.badRequest("invalid-request",
          "登录名要 2 到 32 位，只用英文字母、数字、点、下划线、连字符，并以字母或数字开头（收到的是「"
              + value + "」）");
    }
    return value;
  }

  public static String requireDisplayName(String raw) {
    final String value = raw == null ? "" : raw.trim();
    if (value.length() < DISPLAY_MIN || value.length() > DISPLAY_MAX) {
      throw ApiProblem.badRequest("invalid-request",
          "显示名要 " + DISPLAY_MIN + " 到 " + DISPLAY_MAX + " 个字（收到的是 " + value.length() + " 个）");
    }
    return value;
  }

  /** 角色码必须在四档里。**认不得的角色码不许写进库** —— 写进去就是一个谁都进不来的号 */
  public static String requireRole(String raw) {
    final String value = AdminGate.normalize(raw);
    if (!AdminGate.isKnown(value)) {
      throw ApiProblem.badRole("角色码「" + (raw == null ? "" : raw) + "」不在四档里：" + AdminGate.ROLES);
    }
    return value;
  }

  public static String requirePassword(String raw) {
    final String value = raw == null ? "" : raw;
    if (value.length() < PASSWORD_MIN) {
      throw ApiProblem.badRequest("invalid-request", "口令至少 " + PASSWORD_MIN + " 位");
    }
    if (value.getBytes(StandardCharsets.UTF_8).length > PASSWORD_MAX_BYTES) {
      throw ApiProblem.badRequest("invalid-request",
          "口令超过 " + PASSWORD_MAX_BYTES + " 个字节（BCrypt 只取前 " + PASSWORD_MAX_BYTES
              + " 个字节，再长不会更安全）：换短一点的");
    }
    return value;
  }

  /** 这一行设过口令没有：**以 `$2` 开头才算设过**（`V4` 与 `V16` 的占位行都不算，损坏的散列也不算） */
  public static boolean passwordSet(Object passwordHash) {
    final String hash = passwordHash == null ? "" : String.valueOf(passwordHash).trim();
    return hash.startsWith("$2");
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private Map<String, Object> require(long id) {
    final Map<String, Object> row = writes.userById(id);
    if (row == null) {
      throw ApiProblem.notFound("没有这个账号（id = " + id + "）");
    }
    return row;
  }

  /**
   * "最后一名启用着的管理员"判定。
   *
   * 只在**这一行原本是启用着的管理员**、而这次动作会让他不再是（降级 / 停用 / 删除）时才问库。
   * 问的是"除他之外还有几名启用着的管理员"：0 就拒绝 —— 走到那一步之后，**再没有人能管用户**，
   * 只能去库里手改。
   */
  private void guardLastAdmin(long id, String beforeRole, boolean beforeEnabled, String nextRole,
      boolean nextEnabled) {
    if (!(AdminGate.ROLE_ADMIN.equals(beforeRole) && beforeEnabled)) return;
    if (AdminGate.ROLE_ADMIN.equals(nextRole) && nextEnabled) return;
    if (writes.countOtherEnabledAdmins(id) == 0) {
      throw ApiProblem.lastAdmin("这是最后一名启用着的管理员：先建一个管理员账号（或先把他启用），再改这一行");
    }
  }

  private Map<String, Object> inUseCounts(long id) {
    return Json.obj(
        "schemes", writes.countSchemes(id),
        "revisions", writes.countRevisions(id),
        "shares", writes.countShares(id),
        "configs", writes.countConfigs(id));
  }

  private static boolean anyPositive(Map<String, Object> counts) {
    for (final Object value : counts.values()) {
      if (value instanceof Number n && n.longValue() > 0) return true;
    }
    return false;
  }

  /** 把非零的那几项说成人话（"删不掉"三个字等于让人去猜） */
  private static String inUseMessage(Map<String, Object> counts) {
    final StringBuilder parts = new StringBuilder();
    append(parts, counts, "schemes", "份方案");
    append(parts, counts, "revisions", "条方案版本记录");
    append(parts, counts, "shares", "条分享口令");
    append(parts, counts, "configs", "次参数改动");
    return "这个号还被这些东西引用着（" + parts + "）：先把方案转给别人，或改成停用"
        + "（停用不影响他已经留下的东西，只是他登不进来）";
  }

  private static void append(StringBuilder parts, Map<String, Object> counts, String key, String unit) {
    final Object value = counts.get(key);
    if (value instanceof Number n && n.longValue() > 0) {
      if (parts.length() > 0) parts.append('、');
      parts.append(n.longValue()).append(' ').append(unit);
    }
  }

  /** 一行 → 界面要的形状（列表与单条共用这一处，免得两处字段名慢慢长歪） */
  private static Map<String, Object> view(Map<String, Object> row, Map<String, Long> schemeCounts) {
    return Json.obj(
        "id", row.get("id"),
        "username", str(row.get("username")),
        "displayName", str(row.get("display_name")),
        "roleCode", AdminGate.normalize(str(row.get("role_code"))),
        "enabled", AdminGate.enabled(row.get("enabled")),
        "passwordSet", passwordSet(row.get("password_hash")),
        "schemeCount", schemeCounts.getOrDefault(String.valueOf(row.get("id")), 0L),
        "createdAt", row.get("created_at"),
        "lastLoginAt", row.get("last_login_at"));
  }

  private static String str(Object o) {
    return o == null ? "" : String.valueOf(o);
  }
}
