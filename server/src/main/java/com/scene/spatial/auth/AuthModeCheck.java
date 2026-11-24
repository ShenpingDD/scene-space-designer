package com.scene.spatial.auth;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * AuthModeCheck —— 鉴权档的守卫（U1）
 *
 * 两件事在启动时就会说话（看完这条注释只需要知道：配错了服务起不来）：
 *   第 1 件，`spatial.auth.mode` 只认 `session` 与 `off` 两个值；
 *   第 2 件，`off` 只允许在 `local-nodb` 档使用 —— 那一档没有 `sys_user` 表，
 *          取固定的本机身份；**部署时不存在"把鉴权关掉"这条路**。
 *
 * 反过来，`mode=session` 必须有库（要读 `sys_user`）：配上无库档会当场失败。
 * 拖到运行期才发现的话，每个请求都回 401，看的人会去查数据库连通性，方向全错。
 */
@Component
public class AuthModeCheck {

  private static final Logger log = LoggerFactory.getLogger(AuthModeCheck.class);

  public AuthModeCheck(@Value("${spatial.auth.mode:session}") String mode,
      @Value("${spatial.store:jdbc}") String store,
      Environment env) {
    final String m = mode == null ? "" : mode.trim();
    if (!"session".equals(m) && !"off".equals(m)) {
      throw new IllegalStateException(
          "spatial.auth.mode 只能是 session 或 off，现在是「" + m + "」");
    }
    if ("off".equals(m)) {
      if (!List.of(env.getActiveProfiles()).contains("local-nodb")) {
        throw new IllegalStateException(
            "spatial.auth.mode=off 只允许在 local-nodb 档使用：鉴权不可能在部署时被关掉");
      }
      log.warn("⚠️ 鉴权已关（spatial.auth.mode=off，local-nodb 档）：所有请求按本机身份 admin 处理。"
          + "这一档的用途是「机器上没有 MySQL 时验证服务起得来 + 内核自检还绿」。");
      return;
    }
    if (!"jdbc".equals(store)) {
      throw new IllegalStateException(
          "spatial.auth.mode=session 要读 sys_user 表，而 spatial.store=" + store
              + "：请连库运行，或改用 --spring.profiles.active=local-nodb（那一档鉴权默认关）");
    }
  }
}
