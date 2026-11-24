package com.scene.spatial.auth;

import com.scene.spatial.api.ApiProblem;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;

/**
 * CurrentUser —— "现在是谁"的唯一出处（U1）
 *
 * 业务代码要归属人、要判角色、要写审计，都从这里取；**不许**再有第二处（例如"库里 id 最小的那一行"）。
 *
 * `spatial.auth.mode=off` 只在 `local-nodb` 档被接受（守卫在 {@link AuthModeCheck}），
 * 那一档没有 `sys_user` 表，取固定身份 `id=1 / admin` —— 与 V4 种下的那一行同号，
 * 于是无库档里方案归属的行为与接认证之前一模一样。
 */
@Component
public class CurrentUser {

  /** 无库档的固定身份（与 `V4__seed_local_user.sql` 的 id=1 同号） */
  static final AuthUser OFF_USER = new AuthUser(1L, "local", "本机用户", "admin", true);

  private final boolean off;

  public CurrentUser(@Value("${spatial.auth.mode:session}") String mode) {
    this.off = "off".equals(mode == null ? "" : mode.trim());
  }

  /** 这一档认的是固定身份（无库档） */
  public boolean isOff() {
    return off;
  }

  /** 现在这个请求的身份。没登录就 401 —— 安全链已经挡过一道，这里是兜底（`permitAll` 的口子会走到） */
  public AuthUser require() {
    if (off) return OFF_USER;
    final AuthUser u = orNull();
    if (u == null) {
      throw ApiProblem.unauthorized("未登录或会话已失效：登录之后再做这件事");
    }
    return u;
  }

  /** 没登录就回 null（给 `/api/auth/me` 这类"要回答没登录"的接口用） */
  public AuthUser orNull() {
    if (off) return OFF_USER;
    final Authentication a = SecurityContextHolder.getContext().getAuthentication();
    if (a != null && a.getPrincipal() instanceof SysUserPrincipal p) {
      return p.user();
    }
    return null;
  }

  /** 当前账号 id（`scheme.owner_id`、`created_by`、`updated_by` 都用它） */
  public long id() {
    return require().id();
  }

  /** 当前账号登录名（审计里写"谁改的"） */
  public String username() {
    return require().username();
  }

  /** 当前账号角色码（角色门的输入） */
  public String roleCode() {
    return require().roleCode();
  }
}
