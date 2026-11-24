package com.scene.spatial.auth;

import com.scene.spatial.api.ApiProblem;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.security.web.context.SecurityContextHolderFilter;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.security.web.csrf.CsrfException;
import org.springframework.security.web.csrf.CsrfFilter;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.security.web.csrf.CsrfTokenRepository;
import org.springframework.security.web.csrf.CsrfTokenRequestAttributeHandler;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * SecurityConfig —— 登录鉴权（U1）
 *
 * 三条口径写在这里，别处不再各写一份：
 *
 * 第 1 条，**会话是唯一身份来源**：`HttpSession` + cookie（参数在 `application.yml` 的
 *   `server.servlet.session` 下）。安全上下文存会话里，并且**显式保存**
 *   （`SecurityContextHolderFilter` 默认不替你保存，登录处漏了 `saveContext` 的话，
 *   下一次请求就是匿名的，而且一点都不报错）。
 *
 * 第 2 条，**未登录回 JSON，不做跳转**：关掉 `formLogin` 与 `httpBasic`，
 *   否则未登录会 302 到登录页或弹浏览器原生口令框 —— 这个项目的调用方是 SPA 与脚本，
 *   它们只认 `{ok:false, reason, message}`。
 *
 * 第 3 条，**放行清单就是下面那几行**：健康检查（`start.sh` 的探针与 perf 采样要用）、
 *   登录与登出与"我是谁"、免登录只读分享、型号目录、参数表与参数版本、上传件、
 *   接口说明页、`/error`。其余 `/api/**` 全部要求已登录；非 `/api` 的路径交给容器回 404。
 *   注意前端页面**不在**清单里也不需要：前端由 Vite 提供（开发 5180 / 预览 4180），
 *   后端只服务 `/api/**` 与接口说明页，页面根本不经过这条链。
 *
 * 角色能力（谁能维护产品、谁能发参数、谁能管用户）**不在这里**判断，
 * 仍然只由 `AdminGate` 一处回答 —— 在 URL 上再抄一遍角色匹配，改档位那天一定漏一边。
 */
@Configuration
@EnableWebSecurity
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public class SecurityConfig {

  /** 未登录（或会话失效）：401 + JSON，不跳转 */
  @Bean
  public AuthenticationEntryPoint authenticationEntryPoint() {
    return (request, response, ex) -> AuthJson.write(response,
        ApiProblem.unauthorized("未登录或会话已失效：登录之后再做这件事"));
  }

  /** 已登录但被挡下：CSRF 令牌对不上与角色不够是两件事，回不同的 reason */
  @Bean
  public AccessDeniedHandler accessDeniedHandler() {
    return (request, response, ex) -> {
      if (ex instanceof CsrfException) {
        AuthJson.write(response, ApiProblem.badCsrf());
        return;
      }
      AuthJson.write(response, ApiProblem.forbidden("你的角色不能做这件事"));
    };
  }

  /** 连库档：走登录态的那条链 */
  @Bean
  @ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
  public SecurityFilterChain sessionFilterChain(HttpSecurity http,
      SecurityContextRepository securityContextRepository,
      CsrfTokenRepository csrfTokenRepository,
      AuthenticationEntryPoint authenticationEntryPoint,
      AccessDeniedHandler accessDeniedHandler,
      AccountFreshnessFilter accountFreshnessFilter) throws Exception {
    http
        .securityContext(sc -> sc.securityContextRepository(securityContextRepository))
        .csrf(csrf -> csrf
            .csrfTokenRepository(csrfTokenRepository)
            // 用不掩码的处理器：cookie 里放的就是原始令牌，前端把它回填到请求头即可比对。
            .csrfTokenRequestHandler(new CsrfTokenRequestAttributeHandler()))
        .authorizeHttpRequests(auth -> auth
            .requestMatchers(HttpMethod.GET, "/api/health", "/api/health/**").permitAll()
            .requestMatchers("/api/auth/login", "/api/auth/logout", "/api/auth/me").permitAll()
            .requestMatchers(HttpMethod.GET, "/api/share/**").permitAll()
            // 目录与详情都是公共读：详情只返回已发布快照，不泄露编辑态（docs/105 §6.1）
            .requestMatchers(HttpMethod.GET, "/api/catalog/**").permitAll()
            .requestMatchers(HttpMethod.GET, "/api/params", "/api/params/rev").permitAll()
            .requestMatchers(HttpMethod.GET, "/api/assets/**").permitAll()
            .requestMatchers("/swagger-ui/**", "/swagger-ui.html", "/v3/api-docs/**",
                "/favicon.ico", "/error").permitAll()
            // 其余接口一律要求已登录；**非接口的路径交给容器**（这一档后台只服务
            // `/api/**` 与接口说明页，页面由 Vite 或托管方提供）。
            // 不把最后一条写成 `anyRequest().authenticated()`：那样一个不存在的地址会回 401，
            // 把「没有这个地址」说成「没登录」，看的人会去查登录，方向就错了。
            .requestMatchers("/api/**").authenticated()
            .anyRequest().permitAll())
        .formLogin(AbstractHttpConfigurer::disable)
        .httpBasic(AbstractHttpConfigurer::disable)
        .logout(AbstractHttpConfigurer::disable)
        .sessionManagement(s -> s.sessionFixation(f -> f.changeSessionId()))
        .exceptionHandling(e -> e
            .authenticationEntryPoint(authenticationEntryPoint)
            .accessDeniedHandler(accessDeniedHandler))
        // 最外层：把没人接的拒绝翻译成整站统一的 JSON（CSRF 的失败走这里）
        .addFilterBefore(new SecurityErrorFilter(), SecurityContextHolderFilter.class)
        // 每个已登录请求回库复核一次：停用、改角色、改口令立刻生效
        .addFilterAfter(accountFreshnessFilter, SecurityContextHolderFilter.class)
        // 令牌 cookie 要主动取一次才会写出去（延迟令牌不取就不写）
        .addFilterAfter(new CsrfCookieFilter(), CsrfFilter.class);
    return http.build();
  }

  /**
   * 无库档（`local-nodb`）：鉴权在这一档是关的，取固定的本机身份。
   *
   * 这一档没有 `sys_user` 表，登录不可能成立；`AuthModeCheck` 保证 `mode=off`
   * 只在 `local-nodb` 档被接受，所以这条链不会出现在连库运行的部署里。
   */
  @Bean
  @ConditionalOnProperty(name = "spatial.auth.mode", havingValue = "off")
  public SecurityFilterChain offFilterChain(HttpSecurity http) throws Exception {
    http
        .csrf(AbstractHttpConfigurer::disable)
        .authorizeHttpRequests(auth -> auth.anyRequest().permitAll())
        .formLogin(AbstractHttpConfigurer::disable)
        .httpBasic(AbstractHttpConfigurer::disable)
        .logout(AbstractHttpConfigurer::disable);
    return http.build();
  }

  /** 取一次令牌，触发 `CookieCsrfTokenRepository` 把 cookie 写到响应上 */
  static final class CsrfCookieFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
        FilterChain chain) throws ServletException, IOException {
      final Object token = request.getAttribute(CsrfToken.class.getName());
      if (token instanceof CsrfToken csrfToken) {
        csrfToken.getToken();
      }
      chain.doFilter(request, response);
    }
  }
}
