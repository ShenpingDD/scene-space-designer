package com.scene.spatial.auth;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.TestPropertySource;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * SessionTimeoutTest —— U1 判据 B16：会话闲置超时
 *
 * 单独一个类，因为它要把**这个实例**的会话闲置窗口改小：那个值是按上下文生效的，
 * 混在别的判据里会把它们的时序一起改掉。
 *
 * ## 窗口怎么改小的
 *
 * `server.servlet.session.timeout` 的秒级取值在容器那一层落不下来 —— 实测设成 1 秒之后，
 * 闲置 3 秒再打受保护接口，会话**仍然有效**（回的是 200）。这条判据要判的是
 * 「闲置超过窗口之后会话真的作废」，所以窗口由这个测试自己的一个过滤器用
 * `HttpSession.setMaxInactiveInterval`（单位是秒）压到 1 秒：会话、cookie、登录、超时判定
 * 全部还是容器与这个应用的真东西，只有"多久算闲置"这一个数被调小。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestPropertySource(properties = {
    // LOD 后台作业在测试里是要写盘写库的副作用，关掉：这条判据只关心会话的生死
    "spatial.lod.enabled=false"
})
class SessionTimeoutTest {

  /** 闲置多久之后再去打：窗口是 1 秒，留两个多周期 */
  private static final long IDLE_MILLIS = 3000L;

  private static final String PW = "probe-timeout-9";

  @TestConfiguration
  static class ShortSessionWindow {

    /** 每个已经存在的会话，闲置窗口压到 1 秒（单位是秒 —— 与 `server.servlet.session.timeout` 同一件事） */
    @Bean
    Filter shortSessionWindow() {
      return new OncePerRequestFilter() {
        @Override
        protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain chain) throws ServletException, IOException {
          final HttpSession session = request.getSession(false);
          if (session != null) {
            session.setMaxInactiveInterval(1);
          }
          chain.doFilter(request, response);
        }
      };
    }
  }

  @Value("${local.server.port}")
  private int port;

  @Autowired
  private JdbcClient jdbc;

  @Autowired
  private PasswordEncoder encoder;

  private final List<Long> madeUsers = new ArrayList<>();

  private final String stamp = String.valueOf(Math.abs(System.nanoTime() % 1_000_000L));

  @AfterEach
  void cleanup() {
    for (final long id : madeUsers) {
      jdbc.sql("DELETE FROM scheme WHERE owner_id = :id").param("id", id).update();
      jdbc.sql("DELETE FROM sys_user WHERE id = :id").param("id", id).update();
    }
    madeUsers.clear();
  }

  @Test
  @DisplayName("B16 闲置超过窗口之后会话作废，重新登录又能用")
  void an_idle_session_expires() throws Exception {
    final String u = "pt" + stamp;
    jdbc.sql("""
        INSERT INTO sys_user (username, password_hash, display_name, role_code, enabled)
        VALUES (:u, :h, :d, 'designer', 1)
        """)
        .param("u", u)
        .param("h", encoder.encode(PW))
        .param("d", "超时探针")
        .update();
    madeUsers.add(jdbc.sql("SELECT id FROM sys_user WHERE username = :u").param("u", u)
        .query(Long.class).single());

    final AuthProbe p = new AuthProbe(port);
    assertEquals(200, p.login(u, PW).status(), "先正常登录");
    assertEquals(200, p.get("/api/schemes").status(), "登录之后这个会话是有效的");

    Thread.sleep(IDLE_MILLIS);

    final AuthProbe.Res expired = p.get("/api/schemes");
    assertEquals(401, expired.status(),
        "闲置超过窗口之后，服务端不再认这个会话：" + expired.body());
    assertEquals("unauthorized", expired.reason(), expired.body());

    assertEquals(200, p.login(u, PW).status(), "超时只是会话的事：重新登录立刻又能用");
    assertEquals(200, p.get("/api/schemes").status());
  }
}
