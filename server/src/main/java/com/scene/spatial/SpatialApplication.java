package com.scene.spatial;

import com.scene.spatial.auth.PasswordTool;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * SpatialApplication —— 后端入口
 *
 * 为什么要先把骨架立起来：内核（`com.scene.spatial.kernel`）已经在用 `javac + java` 真跑用例表，
 * 但"**服务能起来**"是另一件事 —— 端口、数据源、Flyway 迁移、配置读取，
 * 这些一旦接上就不好回头改；先立起来，后面每个业务接口都是往这上面加。
 *
 * 业务接口按批次进来：R4-2 方案 CRUD（含乐观锁）→ R4-3 参数管理 → R4-4 前端接后端。
 *
 * 另一条入口：`--set-password &lt;登录名&gt;` 是**一次性口令设置命令**（U1），
 * 它不起 Web 容器，读完口令、写完库就退出（见 {@link PasswordTool}，`tools/server/set-password.sh` 调用它）。
 */
@SpringBootApplication
public class SpatialApplication {

  public static void main(String[] args) {
    // 命令行先判：`--set-password` 那条路不该先起一个 Web 容器再退出
    if (args.length >= 2 && "--set-password".equals(args[0])) {
      System.exit(PasswordTool.run(args[1]));
    }
    SpringApplication.run(SpatialApplication.class, args);
  }
}