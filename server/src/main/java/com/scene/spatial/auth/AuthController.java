package com.scene.spatial.auth;

import com.scene.spatial.admin.AdminRepository;
import com.scene.spatial.admin.UserWriteRepository;
import com.scene.spatial.api.ApiProblem;
import com.scene.spatial.kernel.Json;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.DisabledException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.security.web.csrf.CsrfTokenRepository;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * AuthController —— 登录、登出、会话状态（U1）
 *
 * 三条约定：
 *   第 1 条，未登录**不做跳转**：这条链上的失败都是 JSON（401 或 403，见 `SecurityConfig`），
 *          跳到登录页是前端的事（前端由 Vite 提供，`/login` 这段路由归它管）。
 *   第 2 条，登录成功的响应里**只有身份**（id / 登录名 / 显示名 / 角色码）。
 *          能力表仍只从 `/api/admin/me` 读 —— 同一件事不留两处出处。
 *   第 3 条，`password_hash` 不进任何响应、不进任何日志（本类只打登录名与失败类别）。
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

  private static final Logger log = LoggerFactory.getLogger(AuthController.class);

  /** 没接认证的档（`spatial.auth.mode=off`）没有账号体系，这里拿不到管理器 */
  private final ObjectProvider<AuthenticationManager> managers;
  private final ObjectProvider<UserWriteRepository> userWrites;
  private final ObjectProvider<AdminRepository> reads;
  private final CurrentUser currentUser;
  private final SecurityContextRepository securityContextRepository;
  private final CsrfTokenRepository csrfTokenRepository;

  public AuthController(ObjectProvider<AuthenticationManager> managers,
      ObjectProvider<UserWriteRepository> userWrites,
      ObjectProvider<AdminRepository> reads,
      CurrentUser currentUser,
      SecurityContextRepository securityContextRepository,
      CsrfTokenRepository csrfTokenRepository) {
    this.managers = managers;
    this.userWrites = userWrites;
    this.reads = reads;
    this.currentUser = currentUser;
    this.securityContextRepository = securityContextRepository;
    this.csrfTokenRepository = csrfTokenRepository;
  }

  /** 登录请求体。长度上限只为挡住明显离谱的输入，口令的强度规则在"设口令"那一步 */
  public record LoginRequest(
      @NotBlank(message = "要填登录名") @Size(max = 64, message = "登录名太长") String username,
      @NotBlank(message = "要填口令") @Size(max = 200, message = "口令太长") String password) {
  }

  @PostMapping("/login")
  public Map<String, Object> login(@Valid @RequestBody LoginRequest req,
      HttpServletRequest request, HttpServletResponse response) {
    final AuthenticationManager manager = managers.getIfAvailable();
    if (manager == null) {
      throw ApiProblem.badRequest("auth-off",
          "这一档没有账号体系（spatial.auth.mode=off，只在 local-nodb 档生效）：连库运行才有登录");
    }
    final String username = req.username().trim();
    final Authentication auth;
    try {
      auth = manager.authenticate(
          UsernamePasswordAuthenticationToken.unauthenticated(username, req.password()));
    } catch (BadCredentialsException e) {
      warnIfPlaceholder(username);
      log.warn("登录失败（账号或口令不对）：{}", username);
      throw ApiProblem.badCredentials();
    } catch (DisabledException e) {
      log.warn("登录被拒（账号已停用）：{}", username);
      throw ApiProblem.accountDisabled();
    }

    // 会话固定防护：先确保有会话，再换会话号（换号之后的会话 cookie 会随这次响应下发）
    request.getSession(true);
    request.changeSessionId();
    final SecurityContext context = SecurityContextHolder.createEmptyContext();
    context.setAuthentication(auth);
    SecurityContextHolder.setContext(context);
    // 必须显式保存：`SecurityContextHolderFilter` 默认不替你把上下文写进会话
    securityContextRepository.saveContext(context, request, response);
    // 登录成功轮换 CSRF 令牌，并当场把新令牌写进 cookie ——
    // 不写的话，登录之后第一次写请求会因为"手里还是旧令牌"而回 403。
    csrfTokenRepository.saveToken(csrfTokenRepository.generateToken(request), request, response);

    final AuthUser me = ((SysUserPrincipal) auth.getPrincipal()).user();
    userWrites.ifAvailable(writes -> writes.touchLastLogin(me.id()));
    log.info("登录成功：{}（角色 {}）", me.username(), me.roleCode());
    return Json.obj("ok", true, "user", identity(me));
  }

  @PostMapping("/logout")
  public Map<String, Object> logout(HttpServletRequest request, HttpServletResponse response) {
    final HttpSession session = request.getSession(false);
    if (session != null) {
      session.invalidate();
    }
    SecurityContextHolder.clearContext();
    // 清掉令牌 cookie：下一个访客拿到的是他自己那份令牌
    csrfTokenRepository.saveToken(null, request, response);
    return Json.obj("ok", true);
  }

  /**
   * 会话状态。还承担"把 CSRF 令牌发下来"：任何请求都会（见 `SecurityConfig` 里的取令牌过滤器），
   * 外壳启动时先问这一条，于是登录页拿到的就是可用令牌。
   */
  @GetMapping("/me")
  public Map<String, Object> me() {
    final AuthUser me = currentUser.orNull();
    if (me == null) {
      return Json.obj("ok", true, "authenticated", false);
    }
    return Json.obj("ok", true, "authenticated", true, "user", identity(me));
  }

  /**
   * 占位散列的提示：`V16` 插进去的两个账号行与 `V4` 那一行的 `password_hash`
   * 都是无效值（不以 `$2` 开头），此时 `BCryptPasswordEncoder.matches` 只回 false 并打一条它自己的 WARN。
   * 这里补一条**指出下一步动作**的日志：用 `tools/server/set-password.sh` 设一次口令。
   */
  private void warnIfPlaceholder(String username) {
    final AdminRepository repo = reads.getIfAvailable();
    if (repo == null) return;
    final Map<String, Object> row = repo.userByUsername(username);
    if (row == null) return;
    final String hash = row.get("password_hash") == null ? "" : String.valueOf(row.get("password_hash"));
    if (!hash.startsWith("$2")) {
      log.warn("账号 {} 的 password_hash 是占位值，口令还没设过或设得不生效："
          + "用 bash tools/server/set-password.sh {} 设一次", username, username);
    }
  }

  /** 响应里的身份形状（登录、`/me` 共用一处，免得两处字段名慢慢长歪） */
  private static Map<String, Object> identity(AuthUser me) {
    return Json.obj(
        "id", me.id(),
        "username", me.username(),
        "displayName", me.displayName(),
        "roleCode", me.roleCode());
  }
}
