package com.scene.spatial.auth;

import com.scene.spatial.api.ApiProblem;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.web.csrf.CsrfException;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * SecurityErrorFilter —— 过滤器链里那些**没人接**的拒绝，在这里翻译成整站统一的 JSON
 *
 * 为什么需要它：`CsrfFilter` 排在 `ExceptionTranslationFilter` **前面**，
 * 它抛出的 `InvalidCsrfTokenException` / `MissingCsrfTokenException`（都是
 * `AccessDeniedException` 的子类）根本走不到那个处理者，最终会以容器错误页收场 ——
 * 表现是"令牌不对"回了一个 500 或者一段 HTML，而调用方只认 `{ok:false, reason, message}`。
 *
 * 这个过滤器包在最外层，只接 `AccessDeniedException` 这一族：CSRF 的失败回 403 `bad-csrf`，
 * 其余（授权判定抛上来的）回 403 `forbidden`。控制器里主动抛的 `ApiProblem` 由
 * `ApiAdvice` 处理，压根到不了这里。
 */
public class SecurityErrorFilter extends OncePerRequestFilter {

  @Override
  protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
      FilterChain chain) throws ServletException, IOException {
    try {
      chain.doFilter(request, response);
    } catch (AccessDeniedException ex) {
      if (response.isCommitted()) {
        throw ex;
      }
      if (ex instanceof CsrfException) {
        AuthJson.write(response, ApiProblem.badCsrf());
        return;
      }
      AuthJson.write(response, ApiProblem.forbidden("你的角色不能做这件事"));
    }
  }
}
