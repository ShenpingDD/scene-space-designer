package com.scene.spatial.auth;

import com.scene.spatial.admin.AdminGate;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.userdetails.UserDetails;

import java.util.Collection;
import java.util.List;
import java.util.Map;

/**
 * SysUserPrincipal —— `sys_user` 一行在会话里的样子
 *
 * `passwordHash` 单独放在这里（不进 {@link AuthUser}）：`AccountFreshnessFilter` 每次请求
 * 拿它与库里那一行比对，不一致就说明口令被改过，这次会话当场作废。
 */
public final class SysUserPrincipal implements UserDetails {

  private final AuthUser user;
  private final String passwordHash;

  public SysUserPrincipal(AuthUser user, String passwordHash) {
    this.user = user;
    this.passwordHash = passwordHash == null ? "" : passwordHash;
  }

  /** `sys_user` 的一行 → 身份。列名与 `AdminRepository.userByUsername` 的取数逐列对应 */
  public static SysUserPrincipal of(Map<String, Object> row) {
    return new SysUserPrincipal(
        new AuthUser(
            num(row.get("id")),
            str(row.get("username")),
            str(row.get("display_name")),
            AdminGate.normalize(str(row.get("role_code"))),
            AdminGate.enabled(row.get("enabled"))),
        str(row.get("password_hash")));
  }

  public AuthUser user() {
    return user;
  }

  public String passwordHash() {
    return passwordHash;
  }

  @Override
  public Collection<? extends GrantedAuthority> getAuthorities() {
    return List.of(new SimpleGrantedAuthority("ROLE_" + user.roleCode().toUpperCase(java.util.Locale.ROOT)));
  }

  @Override
  public String getPassword() {
    return passwordHash;
  }

  @Override
  public String getUsername() {
    return user.username();
  }

  @Override
  public boolean isAccountNonExpired() {
    return true;
  }

  @Override
  public boolean isAccountNonLocked() {
    return true;
  }

  @Override
  public boolean isCredentialsNonExpired() {
    return true;
  }

  @Override
  public boolean isEnabled() {
    return user.enabled();
  }

  private static String str(Object o) {
    return o == null ? "" : String.valueOf(o);
  }

  private static long num(Object o) {
    return o instanceof Number n ? n.longValue() : Long.parseLong(String.valueOf(o).trim());
  }
}
