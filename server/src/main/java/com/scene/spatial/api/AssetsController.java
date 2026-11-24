package com.scene.spatial.api;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.regex.Pattern;

/**
 * AssetsController —— 上传件的下发（R6-2）
 *
 * 为什么走 `/api/assets/**` 而不放进 `app/public/assets/`：
 *   ① 那个目录是**构建产物**，`scripts/sync-assets.mjs` 会覆盖它 —— 上传件会被扫掉；
 *   ② `/api` 已经由 Vite 代理到后端，前端因此既不需要知道后端地址，也不需要 CORS。
 *
 * 安全：**名字白名单** —— 只收"单层文件名 + 字母数字点横线"。`..`、路径分隔符一律拒，
 * 再用 normalize + startsWith 二次确认没跑出目录。维护端是唯一写入方，但
 * "只有内部人能用"不算安全理由：目录穿越是**一个字符串就能试**的事。
 */
@RestController
@RequestMapping("/api/assets")
public class AssetsController {

  private static final Pattern SAFE_NAME = Pattern.compile("[A-Za-z0-9._-]{1,120}");

  private final Path dir;

  // ⚠️ 键与 `application.yml` 里声明的必须**同名**（`spatial.uploads.dir`）。这里以前读的是
  //    旧前缀 `xy.uploads.dir` —— 配置里没有这个键，于是它只吃自己的默认值；而"存"由
  //    `ProductAdminController` 按 `spatial.uploads.dir` 落盘 → **存到新目录、还从旧目录读**。
  //    本机默认值恰好相同所以看不出来；换环境设 `SPATIAL_UPLOAD_DIR` 就 404。
  //    （第 2 轮审查 dev-3 的漏改一处；`check-facts.py` 的配置键守卫已改成双向，2026-10-12。）
  public AssetsController(@Value("${spatial.uploads.dir:assets/uploads}") String dir) {
    this.dir = Paths.get(dir).toAbsolutePath().normalize();
  }

  @GetMapping("/{name}")
  public ResponseEntity<Resource> get(@PathVariable String name) {
    if (!SAFE_NAME.matcher(name).matches() || name.contains("..")) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "文件名不合法");
    }
    final Path f = dir.resolve(name).normalize();
    if (!f.startsWith(dir) || !Files.isRegularFile(f)) {
      throw new ResponseStatusException(HttpStatus.NOT_FOUND, "没有这个文件：" + name);
    }
    return ResponseEntity.ok()
        .header(HttpHeaders.CONTENT_TYPE, contentTypeOf(name))
        // 文件名里带校验和 → 内容不可变，可以放心长缓存
        .header(HttpHeaders.CACHE_CONTROL, "public, max-age=31536000, immutable")
        .body(new FileSystemResource(f));
  }

  private static String contentTypeOf(String name) {
    if (name.endsWith(".glb")) return "model/gltf-binary";
    if (name.endsWith(".png")) return MediaType.IMAGE_PNG_VALUE;
    if (name.endsWith(".json")) return MediaType.APPLICATION_JSON_VALUE;
    return MediaType.APPLICATION_OCTET_STREAM_VALUE;
  }
}
