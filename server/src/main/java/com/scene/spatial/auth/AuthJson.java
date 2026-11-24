package com.scene.spatial.auth;

import com.scene.spatial.api.ApiProblem;
import com.scene.spatial.kernel.Json;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;

/**
 * AuthJson —— 过滤器链里的失败出口
 *
 * 安全链的失败发生在 DispatcherServlet 之前，`@RestControllerAdvice` 收不到，
 * 所以入口点、拒绝处理、CSRF 失败、身份复核这几处都要自己写 body。
 * body 的构造仍走 {@link ApiProblem#toBody()}：整站的失败只有一种形状，
 * 这里只是"把同一种形状写到响应流上"。
 */
public final class AuthJson {

  private AuthJson() {
  }

  public static void write(HttpServletResponse response, ApiProblem problem) throws IOException {
    response.setStatus(problem.status());
    response.setContentType("application/json;charset=UTF-8");
    response.getWriter().write(Json.write(problem.toBody(), 0));
    response.getWriter().flush();
  }
}
