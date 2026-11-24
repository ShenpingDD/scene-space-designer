package com.scene.spatial.auth;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.security.web.csrf.CsrfTokenRepository;

/**
 * AuthBeans —— 登录那套**不需要 Web 容器**的构件
 *
 * 为什么不与 `SecurityConfig` 放在一起：过滤器链只在 Servlet 应用里成立
 * （`--set-password` 那条命令行入口不起 Web 容器），而这两件东西是纯对象 ——
 * 命令行档与 `off` 档都要能建出来，否则整个上下文起不来。
 *
 * 会话承载：`HttpSessionSecurityContextRepository`（安全上下文存会话里）。
 * 令牌承载：`CookieCsrfTokenRepository`，**cookie 不是 HttpOnly** ——
 * 同源的页面要读它、把它回填到 `X-XSRF-TOKEN` 请求头；别的站点既读不到这个 cookie，
 * 也发不出带自定义头的请求（双提交的判据就在这里）。
 */
@Configuration
public class AuthBeans {

  @Bean
  public SecurityContextRepository securityContextRepository() {
    return new HttpSessionSecurityContextRepository();
  }

  @Bean
  public CsrfTokenRepository csrfTokenRepository() {
    return CookieCsrfTokenRepository.withHttpOnlyFalse();
  }
}
