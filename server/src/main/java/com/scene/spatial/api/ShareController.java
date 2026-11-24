package com.scene.spatial.api;

import com.scene.spatial.scheme.ShareService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * ShareController —— **免登录**只读分享的读取口（`GET /api/share/{token}`）
 *
 * 这是全项目**唯一不带角色门**的业务接口。理由：打开它的人还没有身份 ——
 * 身份就是他手里那条链接。所以三件事格外讲究：
 *
 *   ① 口令要够随机（**8 位**、无歧义字符集 —— 见 {@link com.scene.spatial.scheme.Share}；
 *      32 位 → 8 位是 2026-10-08 的拍板，理由与代价见 `docs/55` §12.3）；
 *   ② 返回**只有"看方案"需要的东西**（不带方案 id / owner / 文件路径）：
 *      口令持有人能看内容，但**不该顺手拿到调别的接口要用的 id**；
 *   ③ 三种"不能用"给三种话 —— 过期 / 被撤销 / 不存在（见 `ShareService.resolve`）。
 *
 * `GET /api/schemes/{id}/shares`（列出口令）**要门**：口令是凭据，不是"关于方案的说明"。
 */
@RestController
@RequestMapping("/api/share")
public class ShareController {

  private final ShareService service;

  public ShareController(ShareService service) {
    this.service = service;
  }

  @GetMapping("/{token}")
  public Map<String, Object> read(@PathVariable String token) {
    return service.resolve(token);
  }
}
