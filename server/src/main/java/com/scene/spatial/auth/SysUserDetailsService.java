package com.scene.spatial.auth;

import com.scene.spatial.admin.AdminRepository;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;

import java.util.Map;

/**
 * SysUserDetailsService —— 从 `sys_user` 读账号（本地账号体系的实现）
 *
 * 这是 G1 要求的那道**可替换接缝**：将来接统一身份时，加一个
 * `AuthenticationProvider`（或 OIDC 过滤器）挂在同一个 `AuthenticationManager` 上，
 * 登录接口与全部业务代码一行都不用改；`sys_user.external_id` 就是那时对上的键。
 *
 * 口令比对交给 `DaoAuthenticationProvider`（它还会把"账号不存在"包成"口令不对"，
 * 于是外面看不出这个登录名在不在库里）。
 */
public class SysUserDetailsService implements UserDetailsService {

  private final AdminRepository repo;

  public SysUserDetailsService(AdminRepository repo) {
    this.repo = repo;
  }

  @Override
  public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
    final Map<String, Object> row = repo.userByUsername(username);
    if (row == null) {
      throw new UsernameNotFoundException("没有这个账号：" + username);
    }
    return SysUserPrincipal.of(row);
  }
}
