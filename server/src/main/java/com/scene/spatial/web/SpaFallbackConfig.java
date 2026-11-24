package com.scene.spatial.web;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.core.io.Resource;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.servlet.resource.PathResourceResolver;

import java.io.IOException;
import java.util.List;

/**
 * SpaFallbackConfig —— 单 jar 形态的静态资源兜底（docs/81 §五 第 5 项）
 *
 * ## 它补的是哪一个洞
 *
 * 开发时的页面由 Vite（5180）提供，它自带 history 兜底；后端只服务 `/api/**`。
 * 打成单 jar 之后页面改由本进程提供，`/login`、`/design/12` 这类**前端路由**在磁盘上
 * 并没有同名文件 —— 没有兜底的话，用户刷新一次就是 404（页面本身是好的，只是服务端
 * 不知道它该回 index.html）。
 *
 * ## 两条口径
 *
 * 第 1 条，**资源存在就原样返回**：真正的文件（`index.html`、`assets/*.js`、上传件之外
 * 的静态件）走原有解析，一个字节都不改。
 *
 * 第 2 条，**找不到时只有「页面路由」才回 index.html**：`/api/**`（后端接口，含
 * `/api/assets/**` 上传件）、`/assets/**`（构建产物）、`/swagger-ui/**`、`/v3/**`、
 * `/error`、以及**带扩展名**的路径一律不兜底，保持 404。理由：把「没有这个接口」
 * 或「没有这个 js」说成 200 + 首页，会让排错的人去看首页、而不是去看那个地址；
 * 而且 `/api/**` 若被兜底成 200 HTML，前端的 `res.json()` 会报一个与真实原因无关的错。
 *
 * ## 为什么用 `@Order(LOWEST_PRECEDENCE)`
 *
 * Spring Boot 自己的静态资源映射（`WebMvcAutoConfigurationAdapter`，`@Order(0)`）**已经**
 * 注册了一个 `/**` → 四个 classpath 静态目录的映射。同一个 `ResourceHandlerRegistry` 里
 * 相同 pattern 是「后注册覆盖先注册」（`Map.put`），所以要排在 Boot 那个之后，我们这条
 * `/**` 才会生效；否则 Boot 的映射先命中、找不到就 404，兜底永远不会被问到。
 * 其余更具体的 pattern（`/swagger-ui/**`、`/webjars/**`）在同一张映射表里按**最具体匹配**
 * 胜出，不受这条 `/**` 影响。
 *
 * 注意：这条映射只服务 `classpath:/static/`（单 jar 里前端产物就落在那里），
 * Boot 默认的另外三个静态目录（`META-INF/resources`、`resources`、`public`）随之不再生效 ——
 * 本仓没有往那三处放东西。
 */
@Configuration
@Order(Ordered.LOWEST_PRECEDENCE)
public class SpaFallbackConfig implements WebMvcConfigurer {

  /** 前端构建产物在 jar 里的位置（`server/pom.xml` 的 single-jar profile 负责复制过来） */
  static final String STATIC_LOCATION = "classpath:/static/";

  /** SPA 首页：找不到页面路由时回它 */
  static final String INDEX_PAGE = "index.html";

  /**
   * 这些前缀**永远不兜底**（找不到就 404）。
   *
   * `assets` 是 Vite 的构建产物目录；`api` 里还包含 `/api/assets/**` 上传件 ——
   * 上传件属于接口，不能被页面兜底吞掉。
   */
  private static final List<String> BACKEND_PREFIXES = List.of("api", "assets", "swagger-ui", "v3");

  /** 这几个是「不是页面」的独立地址（接口说明页与容器错误页） */
  private static final List<String> BACKEND_PATHS = List.of("swagger-ui.html", "error", "favicon.ico");

  /** 运行期产物目录（LOD 会写到这里；单 jar 部署时不在 classpath 里） */
  @Value("${spatial.assets-dir:assets}")
  private String assetsDir;

  @Override
  public void addResourceHandlers(ResourceHandlerRegistry registry) {
    // LOD 是**运行期**写进仓库根 assets/ 的，不会自动进 jar 的 classpath:/static/。
    // 先给 /assets/** 一条独立映射：classpath（构建期产物）优先，再回落工作目录的 file:assets/。
    // 这条不能用 /** 的 SPA resolver：/assets/** 找不到文件必须 404，不能回 index.html。
    registry.addResourceHandler("/assets/**")
        .addResourceLocations("classpath:/static/assets/", "file:" + assetsDir + "/")
        .setCacheControl(org.springframework.http.CacheControl.noCache());

    registry.addResourceHandler("/**")
        .addResourceLocations(STATIC_LOCATION)
        // `resourceChain(false)`：不缓存资源，但要一条解析链 —— 没有链时自定义 resolver 不生效
        .resourceChain(false)
        .addResolver(new SpaPathResourceResolver());
  }

  /**
   * 判断一个（已去掉前导斜杠的）资源路径是不是「前端页面路由」。
   *
   * 是 → 找不到文件时回 `index.html`；不是 → 保持 404。
   */
  static boolean isSpaRoute(String resourcePath) {
    if (resourcePath == null) {
      return false;
    }
    String path = resourcePath;
    while (path.startsWith("/")) {
      path = path.substring(1);
    }
    if (path.isEmpty()) {
      return true;   // 根路径：回首页
    }
    for (String prefix : BACKEND_PREFIXES) {
      if (path.equals(prefix) || path.startsWith(prefix + "/")) {
        return false;
      }
    }
    if (BACKEND_PATHS.contains(path)) {
      return false;
    }
    // 带扩展名（最后一段里有小数点）＝ 在找一个具体的文件，找不到就是 404
    String lastSegment = path.substring(path.lastIndexOf('/') + 1);
    return !lastSegment.contains(".");
  }

  /**
   * 先按真实文件解析；找不到且是页面路由时回 `index.html`，其余一律 null（= 404）。
   *
   * `super.getResource(...)` 里带着路径穿越校验，所以每个分支都走它、不自己拼 Resource。
   */
  static final class SpaPathResourceResolver extends PathResourceResolver {

    @Override
    protected Resource getResource(String resourcePath, Resource location) throws IOException {
      Resource found = super.getResource(resourcePath, location);
      // 根路径（resourcePath 为空）在目录上可能被判成可读，这里统一按首页处理
      if (found != null && !resourcePath.isEmpty()) {
        return found;
      }
      if (!isSpaRoute(resourcePath)) {
        return null;
      }
      return super.getResource(INDEX_PAGE, location);
    }
  }
}
