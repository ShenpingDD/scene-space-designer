package com.scene.spatial.auth;

import com.scene.spatial.admin.AdminRepository;
import com.scene.spatial.api.ApiProblem;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Map;
import java.util.Objects;

/**
 * AccountFreshnessFilter —— 每个已登录请求按主键**回库复核一次**（U1）
 *
 * 会话里存的是登录那一刻的身份。不回读的话，"停用这个账号"要等到他的会话过期才生效，
 * 而会话闲置超时是 8 小时 —— 那等于停用按钮按下去没有用。
 *
 * 这里做三件事（用户表是几十行的量级，一次主键查询的代价接受）：
 *   第 1 件，行没了或 `enabled = 0` → 这次会话当场作废并回 401；
 *   第 2 件，`password_hash` 与会话里记的不一致 → 口令被改过，同样作废；
 *   第 3 件，其余情况按库里那一行**刷新角色与显示名**，改了角色立刻生效。
 *
 * 第 3 件只在本次请求的内存里生效（`HttpSessionSecurityContextRepository` 默认只加载不保存），
 * 所以下一个请求仍然以库里的那一行为准 —— 这正是"库是唯一真相"的意思。
 */
public class AccountFreshnessFilter extends OncePerRequestFilter {

  private final AdminRepository repo;

  public AccountFreshnessFilter(AdminRepository repo) {
    this.repo = repo;
  }

  @Override
  protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
      FilterChain chain) throws ServletException, IOException {
    final Authentication auth = SecurityContextHolder.getContext().getAuthentication();
    if (auth != null && auth.getPrincipal() instanceof SysUserPrincipal current) {
      final Map<String, Object> row = repo.userById(current.user().id());
      if (row == null || !fresh(row, current)) {
        SecurityContextHolder.clearContext();
        final HttpSession session = request.getSession(false);
        if (session != null) {
          session.invalidate();
        }
        AuthJson.write(response, ApiProblem.unauthorized(
            "登录状态已失效（账号被停用、被删除或口令已改）：请重新登录"));
        return;
      }
      final SysUserPrincipal refreshed = SysUserPrincipal.of(row);
      // 用具体类型接住：`Authentication` 这个接口在 Security 7 里已经没有 `setDetails`
      final UsernamePasswordAuthenticationToken replaced = UsernamePasswordAuthenticationToken
          .authenticated(refreshed, null, refreshed.getAuthorities());
      replaced.setDetails(auth.getDetails());
      SecurityContextHolder.getContext().setAuthentication(replaced);
    }
    chain.doFilter(request, response);
  }

  /** 库里的那一行还算不算同一个人：启用着、且口令散列没变过（转换口径与 `SysUserPrincipal.of` 同一处） */
  private static boolean fresh(Map<String, Object> row, SysUserPrincipal sessionUser) {
    final SysUserPrincipal now = SysUserPrincipal.of(row);
    return now.isEnabled() && Objects.equals(now.passwordHash(), sessionUser.passwordHash());
  }
}
