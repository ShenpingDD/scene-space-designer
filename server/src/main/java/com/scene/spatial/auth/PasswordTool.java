package com.scene.spatial.auth;

import com.scene.spatial.SpatialApplication;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.io.BufferedReader;
import java.io.Console;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * PasswordTool —— 一次性口令设置命令（U1）
 *
 * ## 为什么做成一条命令
 * `V16` 只插账号行（`enabled = 0` + 占位哈希），仓库里一条口令都没有。第一个管理员总得有人给一次口令，
 * 而开一个免登录的写接口等于把「谁都能拿管理员」这件事永久留在系统里 ——
 * 这条命令要求先能登进这台机器、能连上这个库（见 设计决策记录 §五第 5 项）。
 *
 * ## 口令从哪来
 * 从**控制台或标准输入**读，只带用户名：不进 shell 历史、不进进程命令行、不打印。
 * 控制台读不到时（例如被管道喂进来）就从标准输入读一行。
 *
 * ## 用法与退出码
 * <pre>
 *   java -jar spatial-design-server-0.1.0-SNAPSHOT.jar --set-password &lt;登录名&gt;
 * </pre>
 * `tools/server/set-password.sh` 把这段话包了一层。退出码：0 = 改到了 1 行；
 * 1 = 没有这个用户名（一行都没改到）；2 = 用法或口令不合格。
 */
public final class PasswordTool {

  /** 口令长度的下限：与维护端重置口令那一口（`UserAdminService.PASSWORD_MIN`）同一个数 */
  private static final int MIN_LENGTH = 8;

  private PasswordTool() {
  }

  public static int run(String username) {
    if (username == null || username.isBlank()) {
      System.err.println("用法：java -jar <jar> --set-password <登录名>");
      return 2;
    }
    final String name = username.trim();
    final String password = readPassword(name);
    if (password.length() < MIN_LENGTH) {
      System.err.println("口令太短：至少要 " + MIN_LENGTH + " 位（收到 " + password.length() + " 位）。");
      return 2;
    }

    // 只起上下文、不起 Web 容器：这条命令不服务任何请求。
    // `--spatial.lod.enabled=false` 显式带上：设一次口令不该顺手把 LOD 作业拉起来。
    final SpringApplication app = new SpringApplication(SpatialApplication.class);
    app.setWebApplicationType(WebApplicationType.NONE);
    try (ConfigurableApplicationContext ctx = app.run("--spatial.lod.enabled=false")) {
      final JdbcClient jdbc = ctx.getBean(JdbcClient.class);
      final PasswordEncoder encoder = ctx.getBean(PasswordEncoder.class);
      final int hit = jdbc.sql(
              "UPDATE sys_user SET password_hash = :hash, enabled = 1 WHERE username = :name")
          .param("hash", encoder.encode(password))
          .param("name", name)
          .update();
      if (hit == 0) {
        System.err.println("没有这个用户名：" + name + " —— 一行都没改到，口令没有写入。");
        return 1;
      }
      return report(jdbc, name, hit);
    }
  }

  /**
   * 回库数一遍（AGENTS §4：跑完必须回库 `SELECT`，不看日志）。
   *
   * 「改到了几行」与「库里现在是什么」是两件事：`UPDATE` 影响 1 行不代表那一行真的是我们想要的样子，
   * 所以这里把 `enabled` 与口令是否设过一起读回来打印。
   */
  private static int report(JdbcClient jdbc, String name, int hit) {
    final List<Map<String, Object>> rows = jdbc.sql(
            "SELECT id, username, role_code, enabled, password_hash FROM sys_user WHERE username = :name")
        .param("name", name)
        .query().listOfRows();
    System.out.println("改到 " + hit + " 行；回库读到 " + rows.size() + " 行。");
    for (final Map<String, Object> r : rows) {
      final String hash = String.valueOf(r.get("password_hash"));
      System.out.println("  id=" + r.get("id")
          + " 登录名=" + r.get("username")
          + " 角色=" + r.get("role_code")
          + " enabled=" + r.get("enabled")
          + " 口令已设=" + (hash.startsWith("$2") ? "是" : "否"));
    }
    return rows.isEmpty() ? 1 : 0;
  }

  /**
   * 读口令。控制台可用时用 `readPassword`（不回显），否则从标准输入读一行。
   *
   * 两条路都不打印口令本身 —— 口令只活在内存里，最后进库的是哈希。
   */
  private static String readPassword(String name) {
    final Console console = System.console();
    if (console != null) {
      final char[] chars = console.readPassword("给 %s 设置新口令（不回显，至少 %d 位）：", name, MIN_LENGTH);
      return chars == null ? "" : new String(chars);
    }
    System.out.println("请从标准输入给 " + name + " 喂一行新口令（至少 " + MIN_LENGTH + " 位）：");
    try {
      final BufferedReader in =
          new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
      final String line = in.readLine();
      return line == null ? "" : line;
    } catch (IOException e) {
      throw new IllegalStateException("读标准输入失败：" + e.getMessage(), e);
    }
  }
}
