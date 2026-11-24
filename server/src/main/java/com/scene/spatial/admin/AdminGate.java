package com.scene.spatial.admin;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * AdminGate —— 维护端与前台设计器的**角色门**（R6-1 建，R6-4 B4e 做真四档，U1 接上登录态）
 *
 * 角色的来源是**登录账号**：`sys_user.role_code` 由 `AccountFreshnessFilter` 每次请求复核，
 * 停用、改角色、改口令立刻生效。所以这道门现在是服务端判定的边界：
 * 前端藏的是入口，这里守的是数据，换个地址栏绕不过去。
 * 仍然要说在界面上的是另一件事：本系统在内网以明文 HTTP 运行，口令与分享链接不要转发到内网以外。
 *
 * ## 四档（唯一出处 `docs/PROJECT-SPEC.md`「角色档位」，拍板 A14）
 *
 * | 角色 | 谁 | 能做什么 | 不能做什么 |
 * | --- | --- | --- | --- |
 * | `admin` | 管理员 | 全部（含用户管理、发布参数） | — |
 * | `editor` | 维护端维护者 | 维护端：产品 / 型号 / 方案库；前台建改方案 | **发布参数**（`docs/32` §风险表：参数只有 admin 能发） |
 * | `designer` | 前台场景空间设计器的设计师 | 前台设计器：建 / 改方案 | 进维护端、发布参数 |
 * | `viewer` | 只读 | 看（前台看方案、维护端看产品与参数与审计） | 任何写动作 |
 *
 * ## 两条设计约束
 *
 * 1. **认不得的角色 = 什么都不能做**（fail-closed）：空角色码、拼错的 `Admin`、将来多出来的第五档，
 *    一律按"没有权限"处理，并且 {@link #isKnown} 会让界面把这件事**说出来**
 *    （「角色码 `xxx` 不在四档里，按只读以下处理」）—— 静默降级比拒绝更坏。
 * 2. **能力是"能不能做某件事"，不是"是不是某个角色"**。控制器里写 `canPublishParams(role)`，
 *    不写 `role.equals("admin")` —— 将来把发布权交给 editor 时，只改这一个地方。
 */
public final class AdminGate {

  private AdminGate() {}

  public static final String ROLE_ADMIN = "admin";
  public static final String ROLE_EDITOR = "editor";
  public static final String ROLE_DESIGNER = "designer";
  public static final String ROLE_VIEWER = "viewer";

  /** 四档的声明顺序（界面按这个顺序列；`PROJECT-SPEC.md` 的表格同序） */
  public static final List<String> ROLES = List.of(ROLE_ADMIN, ROLE_EDITOR, ROLE_DESIGNER, ROLE_VIEWER);

  /**
   * 角色码归一：**只去空白**（库里、或手改过库的，可能前后带空格）。
   *
   * ⚠️ **刻意不做大小写模糊匹配**（R6-1 的既有决定，B4e 保留）：角色代码是机器标识，
   *    认 `Admin` 等于在匹配上留一个"看起来差不多就算"的口子，而这道门挡的正是误操作。
   *    认不得的角色码不会进任何一档 —— 但会被 {@link #isKnown} 指出来（界面必须说出来，见下）。
   */
  public static String normalize(String roleCode) {
    return roleCode == null ? "" : roleCode.trim();
  }

  /** 这个角色码是不是四档之一。**认不得要说出来**，不许当"大概是 viewer 吧" */
  public static boolean isKnown(String roleCode) {
    return ROLES.contains(normalize(roleCode));
  }

  /**
   * `sys_user.enabled` 一列的取值归一。
   *
   * 驱动按 `TINYINT(1)` 取出来是 `Boolean`，换成别的列宽或别的驱动就是数字文本 ——
   * 两种都要认，而且**只在这一处认**（认证、身份复核、用户管理列表三处共用它）。
   */
  public static boolean enabled(Object raw) {
    if (raw == null) return false;
    if (raw instanceof Boolean flag) return flag;
    if (raw instanceof Number number) return number.intValue() != 0;
    final String text = String.valueOf(raw).trim();
    return "1".equals(text) || "true".equalsIgnoreCase(text);
  }

  /** 能不能进维护端。`designer` **不进**：维护端不是他的工作面（他只用前台设计器） */
  public static boolean canEnterAdmin(String roleCode) {
    return switch (normalize(roleCode)) {
      case ROLE_ADMIN, ROLE_EDITOR, ROLE_VIEWER -> true;
      default -> false;
    };
  }

  /** 能不能维护目录与产品（上传 GLB、建型号、改产品）—— admin / editor */
  public static boolean canMaintain(String roleCode) {
    return switch (normalize(roleCode)) {
      case ROLE_ADMIN, ROLE_EDITOR -> true;
      default -> false;
    };
  }

  /**
   * 能不能在前台建 / 改方案 —— admin / editor / designer。
   *
   * `editor` 也在内：前台设计器是他的工作面之一（`writeSchemes` 一直把他算进来，
   * 界面也按 `writeSchemes` 禁用按钮）。两处口径收成一处，方案库里那半排点不动的按钮跟着消失。
   */
  public static boolean canDesign(String roleCode) {
    return switch (normalize(roleCode)) {
      case ROLE_ADMIN, ROLE_EDITOR, ROLE_DESIGNER -> true;
      default -> false;
    };
  }

  /** 能不能改方案（前台的设计师 + 维护端管方案库的人，两拨合起来才是"能改方案"） */
  public static boolean canWriteSchemes(String roleCode) {
    return canDesign(roleCode) || canMaintain(roleCode);
  }

  /** 能不能**发布**规则参数 —— 只有 admin（`docs/32` §风险表：「谁都能改参数」是要防的事） */
  public static boolean canPublishParams(String roleCode) {
    return ROLE_ADMIN.equals(normalize(roleCode));
  }

  /**
   * 能不能**管用户** —— 只有 admin。
   *
   * 建号、改角色、重置口令都是把权限交出去的动作；与发布参数同一档位。
   */
  public static boolean canManageUsers(String roleCode) {
    return ROLE_ADMIN.equals(normalize(roleCode));
  }

  /** 能不能看（四档都能看；**认不得的角色不能**） */
  public static boolean canView(String roleCode) {
    return isKnown(roleCode);
  }

  /** 是不是 admin 这一档（`/api/admin/me` 的 `isAdmin` 用它；不是"能不能进维护端"） */
  public static boolean canAdmin(String roleCode) {
    return ROLE_ADMIN.equals(normalize(roleCode));
  }

  /**
   * 一次给全的能力表（`/api/admin/me` 带出去）。
   *
   * 为什么整表发、而不是让前端自己按 `roleCode` 判断：**判断只许有一处**。
   * 前端再抄一遍四档对照表，改档位那天就会改漏一边（本项目对"两处同一件事"的一贯态度）。
   */
  public static Map<String, Boolean> caps(String roleCode) {
    final Map<String, Boolean> out = new LinkedHashMap<>();
    out.put("enterAdmin", canEnterAdmin(roleCode));
    out.put("view", canView(roleCode));
    out.put("maintain", canMaintain(roleCode));
    out.put("design", canDesign(roleCode));
    out.put("writeSchemes", canWriteSchemes(roleCode));
    out.put("publishParams", canPublishParams(roleCode));
    out.put("manageUsers", canManageUsers(roleCode));
    return out;
  }
}