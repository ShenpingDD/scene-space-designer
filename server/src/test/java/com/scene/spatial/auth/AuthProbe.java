package com.scene.spatial.auth;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.CookieManager;
import java.net.HttpCookie;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * AuthProbe —— 带真实登录会话的 HTTP 探针（U1 的判据共用）
 *
 * 一条判据要证明「登录真的建立了会话」，只能走真实登录、真实 cookie、真实库：
 * 手写 `SecurityContext` 或换成替身的登录服务，会把登录、停用、会话、CSRF 这几条
 * 一起绕过去，而它们恰恰是本批要判的东西。
 *
 * 这个类只做两件事：**维持一份 cookie 罐**、按顺序发请求。判什么仍然写在各自的测试类里 ——
 * 探针不替判据下结论，也不替判据挑状态码。
 *
 * 令牌的处理与真实界面一致：先 `GET /api/auth/me`（这一步会把 `XSRF-TOKEN` cookie 发下来），
 * 之后每个请求都把它的值回填到 `X-XSRF-TOKEN` 请求头。少了这一步，写请求会在 CSRF 那一层
 * 被挡成 403，而那时看到的 403 与"角色不够"分不清。
 */
public final class AuthProbe {

  /** CSRF 令牌的 cookie 名（与 `AuthBeans` 里 `CookieCsrfTokenRepository` 的默认名同口径） */
  public static final String CSRF_COOKIE = "XSRF-TOKEN";

  /** CSRF 令牌的请求头名 */
  public static final String CSRF_HEADER = "X-XSRF-TOKEN";

  private static final ObjectMapper JSON = new ObjectMapper();

  private final String base;
  private final CookieManager jar = new CookieManager();
  private final HttpClient client;

  public AuthProbe(int port) {
    this.base = "http://127.0.0.1:" + port;
    this.client = HttpClient.newBuilder()
        .cookieHandler(jar)
        .connectTimeout(Duration.ofSeconds(10))
        .build();
  }

  /** 一次请求的读数：状态码 + 响应体 + 响应头（响应头要留：会话 cookie 的属性就写在那里） */
  public record Res(int status, String body, HttpHeaders headers) {

    public Map<String, Object> json() {
      try {
        return JSON.readValue(body, new TypeReference<LinkedHashMap<String, Object>>() {
        });
      } catch (Exception e) {
        throw new IllegalStateException("响应体不是 JSON 对象（HTTP " + status + "）：" + body, e);
      }
    }

    /** 失败原因码（`{ok:false, reason, message}` 里的 reason） */
    public String reason() {
      final Object r = json().get("reason");
      return r == null ? null : String.valueOf(r);
    }

    /** 某一条响应头的原文（多条时取第一条） */
    public String header(String name) {
      return headers.firstValue(name).orElse(null);
    }

    public boolean is2xx() {
      return status >= 200 && status < 300;
    }
  }

  /** 当前 cookie 罐里的 CSRF 令牌（还没有就回 null） */
  public String csrf() {
    for (final HttpCookie c : jar.getCookieStore().getCookies()) {
      if (CSRF_COOKIE.equals(c.getName())) {
        return c.getValue();
      }
    }
    return null;
  }

  /** 当前 cookie 罐里的 cookie 名（诊断用：会话 cookie 到底有没有被收下） */
  public List<String> cookieNames() {
    return jar.getCookieStore().getCookies().stream().map(HttpCookie::getName).sorted().toList();
  }

  /** 先问一次「我是谁」：它顺手把 CSRF 令牌发下来（真实界面启动时做的同一件事） */
  public Res primeCsrf() {
    return get("/api/auth/me");
  }

  /** 真实登录：先取令牌，再提交登录名与口令 */
  public Res login(String username, String password) {
    primeCsrf();
    final Map<String, Object> body = new LinkedHashMap<>();
    body.put("username", username);
    body.put("password", password);
    return post("/api/auth/login", body);
  }

  public Res logout() {
    return post("/api/auth/logout", new LinkedHashMap<String, Object>());
  }

  public Res get(String path) {
    return call("GET", path, null, null);
  }

  /** 带 `If-None-Match` 的 GET：只为判缓存命中（304）用，别拿它绕鉴权。 */
  public Res getWithEtag(String path, String etag) {
    final HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path))
        .timeout(Duration.ofSeconds(30))
        .header("If-None-Match", etag)
        .GET();
    try {
      final HttpResponse<String> r = client.send(b.build(), HttpResponse.BodyHandlers.ofString());
      return new Res(r.statusCode(), r.body(), r.headers());
    } catch (Exception e) {
      throw new IllegalStateException("打 GET " + path + "（带 ETag）时连不上测试实例："
          + e.getMessage(), e);
    }
  }

  public Res delete(String path) {
    return call("DELETE", path, null, null);
  }

  public Res post(String path, Object body) {
    return call("POST", path, encode(body), "application/json");
  }

  public Res put(String path, Object body) {
    return call("PUT", path, encode(body), "application/json");
  }

  public Res patch(String path, Object body) {
    return call("PATCH", path, encode(body), "application/json");
  }

  /** 刻意用别的 `Content-Type` 发一次（判「只收 JSON 的接口不许回 5xx」那一族要用） */
  public Res postAs(String path, String rawBody, String contentType) {
    return call("POST", path, rawBody, contentType);
  }

  /**
   * 发一次请求。`rawBody` 为 null 时不带请求体。
   *
   * 令牌头**按当前 cookie 回填**：cookie 罐里没有令牌时就不带这一头（那正是"没取过令牌的调用方"
   * 的样子）—— 「不带令牌的写请求会被挡下」这条判据要靠它才判得出来。
   */
  public Res call(String method, String path, String rawBody, String contentType) {
    return call(method, path, rawBody, contentType, true);
  }

  /** 刻意**不带**令牌头发一次：判「令牌真的在服务端被校验过」 */
  public Res callWithoutCsrf(String method, String path, String rawBody, String contentType) {
    return call(method, path, rawBody, contentType, false);
  }

  private Res call(String method, String path, String rawBody, String contentType, boolean withCsrf) {
    final HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path))
        .timeout(Duration.ofSeconds(30));
    final String token = csrf();
    if (withCsrf && token != null) {
      b.header(CSRF_HEADER, token);
    }
    if (contentType != null) {
      b.header("Content-Type", contentType);
    }
    b.method(method, rawBody == null
        ? HttpRequest.BodyPublishers.noBody()
        : HttpRequest.BodyPublishers.ofString(rawBody));
    try {
      final HttpResponse<String> r = client.send(b.build(), HttpResponse.BodyHandlers.ofString());
      return new Res(r.statusCode(), r.body(), r.headers());
    } catch (Exception e) {
      throw new IllegalStateException("打 " + method + " " + path + " 时连不上测试实例："
          + e.getMessage(), e);
    }
  }

  private static String encode(Object body) {
    if (body == null) {
      return null;
    }
    if (body instanceof String s) {
      return s;
    }
    try {
      return JSON.writeValueAsString(body);
    } catch (Exception e) {
      throw new IllegalStateException("请求体无法序列化成 JSON：" + body, e);
    }
  }
}
