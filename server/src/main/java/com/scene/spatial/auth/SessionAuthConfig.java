package com.scene.spatial.auth;

import com.scene.spatial.admin.AdminRepository;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.ProviderManager;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

/**
 * SessionAuthConfig —— 连库档（`spatial.store=jdbc`）的认证组件
 *
 * 条件写成 `spatial.store=jdbc` 就够了：`spatial.auth.mode=off` 只允许在 local-nodb 档使用
 * （见 {@link AuthModeCheck}），所以「连库」与「走登录态」在这一版里是同一件事。
 * 无库档下这几个 bean 全都不存在，也不会被谁依赖（登录接口用 `ObjectProvider` 拿管理器）。
 */
@Configuration
@ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
public class SessionAuthConfig {

  /** 口令散列的唯一出处：BCrypt、工作因子 10（`password_hash` 是 VARCHAR(100)，BCrypt 输出 60 字符） */
  @Bean
  public PasswordEncoder passwordEncoder() {
    return new BCryptPasswordEncoder();
  }

  @Bean
  public SysUserDetailsService sysUserDetailsService(AdminRepository repo) {
    return new SysUserDetailsService(repo);
  }

  @Bean
  public DaoAuthenticationProvider daoAuthenticationProvider(SysUserDetailsService users,
      PasswordEncoder encoder) {
    final DaoAuthenticationProvider provider = new DaoAuthenticationProvider(users);
    provider.setPasswordEncoder(encoder);
    // 刻意不改 hideUserNotFoundExceptions（默认 true）：「账号不存在」与「口令不对」
    // 对外必须是同一句话，否则登录框就成了一个查询登录名是否存在的工具。
    return provider;
  }

  @Bean
  public AuthenticationManager authenticationManager(DaoAuthenticationProvider provider) {
    return new ProviderManager(provider);
  }

  @Bean
  public AccountFreshnessFilter accountFreshnessFilter(AdminRepository repo) {
    return new AccountFreshnessFilter(repo);
  }
}
