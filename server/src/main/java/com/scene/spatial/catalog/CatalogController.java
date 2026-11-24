package com.scene.spatial.catalog;

import com.scene.spatial.admin.AdminService;
import com.scene.spatial.admin.ProductContentService;
import com.scene.spatial.kernel.Catalog;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.context.request.WebRequest;

import jakarta.servlet.http.HttpServletResponse;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * CatalogController —— `GET /api/catalog`：把**库里的目录**交给前端。
 *
 * 为什么要有这个接口：目录过去是**构建期**从 JSON 生成的 JS 资产（`app/src/data/catalog.js`），
 * 也就是"维护端改了库、界面不知道"。接上它之后界面读库，本地资产退居**离线兜底**
 * （后端不可用时前端自动退回），并且界面上会写明当前用的是哪一份。
 *
 * ## 顺带回答一个必须问的问题：服务端内核到底认不认库里这些型号？
 *
 * `kernel` 字段是**对内核 bean 的实测自检**（不是把库跟库自己比）：逐款拿 id 去问
 * `Catalog.footprint()`，认不出 / 占地口径不一致都会被点名并打 WARN。
 *
 * 这条自检是有来历的：接库之前内核目录是**用例表内嵌的 3 款**，而库里是 4 款 ——
 * `demo-freezer-upright`（立式低温保存箱系列）界面能摆、服务端报 `bad-item`，**保存直接被挡**，
 * 而且没有任何地方会告诉你"服务端少认识一款"。现在它自己会喊。
 */
@RestController
@RequestMapping("/api/catalog")
@ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
public class CatalogController {

  private static final Logger log = LoggerFactory.getLogger(CatalogController.class);

  private final DbCatalog db;
  private final CatalogSource catalogs;
  private final AdminService admin;
  private final ProductContentService content;

  public CatalogController(DbCatalog db, CatalogSource catalogs, AdminService admin,
                           ProductContentService content) {
    this.db = db;
    this.catalogs = catalogs;
    this.admin = admin;
    this.content = content;
  }

  @GetMapping
  public Map<String, Object> get(HttpServletResponse response) {
    // 目录是"当前状态"的读数，不是可长期缓存的内容；浏览器启发式缓存会让新激活产品迟到（P0-5）
    if (response != null) response.setHeader("Cache-Control", "no-cache");
    // 每次请求都问"当前目录"：后台改完目录，下一次请求就是新结论（不用重启）
    final Catalog kernel = catalogs.current();
    final Map<String, Object> payload = new LinkedHashMap<>(db.uiPayload());
    @SuppressWarnings("unchecked")
    final List<Map<String, Object>> products = (List<Map<String, Object>>) payload.get("products");
    final List<String> unknown = new ArrayList<>();
    final List<Map<String, Object>> mismatched = new ArrayList<>();
    for (final Map<String, Object> p : products) {
      final String id = String.valueOf(p.get("id"));
      final double[] f = kernel.footprint(id);
      if (f == null) {
        unknown.add(id);
        continue;
      }
      final double w = ((Number) p.get("w")).doubleValue();
      final double d = ((Number) p.get("d")).doubleValue();
      if (Math.abs(f[0] - w) > 1e-6 || Math.abs(f[1] - d) > 1e-6) {
        mismatched.add(Map.of("id", id, "catalog", List.of(w, d), "kernel", List.of(f[0], f[1])));
      }
    }
    final Map<String, Object> k = new LinkedHashMap<>();
    k.put("size", kernel.size());
    k.put("unknown", unknown);
    k.put("mismatched", mismatched);
    k.put("match", unknown.isEmpty() && mismatched.isEmpty());
    payload.put("kernel", k);
    payload.put("origin", catalogs.origin());
    payload.put("rev", catalogs.version());
    if (!unknown.isEmpty() || !mismatched.isEmpty()) {
      log.warn("[catalog] 内核不认这些型号（界面能摆、服务端会挡）：unknown={} mismatched={}", unknown, mismatched);
    }
    return payload;
  }

  /**
   * 产品详情（设计端公共读）：只返回已发布快照；老产品走只读投影。
   *
   * 为什么把 detail 放在 catalog 路径下：它回答的是「这款目录产品点开是什么」，
   * 与分享页将来复用同一个接口；不是维护端的私有数据，所以 permitAll。
   */
  @GetMapping("/{catalogId}/detail")
  public ResponseEntity<Map<String, Object>> detail(@PathVariable String catalogId, WebRequest request) {
    final ProductContentService.Detail d = content.detail(catalogId);
    final HttpHeaders headers = new HttpHeaders();
    headers.setETag(d.etag());
    // 发布后浏览器默认 fetch 必须立刻看到新快照：只允许“带 ETag 回来问”，不允许 30s 内直接命中旧 body。
    // （P0-QA-08d 实测：max-age=30 时保存后默认请求仍拿旧 counts；改成 no-cache + ETag 后 304/200 都正确。）
    headers.setCacheControl(CacheControl.noCache().cachePublic());
    if (request.checkNotModified(d.etag())) {
      return new ResponseEntity<>(headers, HttpStatus.NOT_MODIFIED);
    }
    return new ResponseEntity<>(d.body(), headers, HttpStatus.OK);
  }

  /**
   * 立即重读目录（不等那 1 秒的自动重读）。
   *
   * 给谁用：将来维护端在后台改完型号 / 文案，保存后调一次，**当场生效**。
   * 返回的就是重读后的目录，所以"刷了没刷"一调就知道。
   *
   * ## 为什么它也要角色门
   * 它改的是**进程内共享状态**（`catalogs.reload()` 会重建目录快照）—— 所有使用者一起受影响，
   * 是写动作。它原来是写类接口里**唯一没有门**的一处（第 2 轮审查 dev-6）。门设在"进维护端"
   * 不够：`requireEnterAdmin` 只证明你能看。**改共享状态要 maintain**，与其它写动作一视同仁。
   */
  @PostMapping("/reload")
  public Map<String, Object> reload() {
    admin.requireMaintain();
    catalogs.reload();
    log.info("[catalog] 手动重读目录 —— 来源={} version={}", catalogs.origin(), catalogs.version());
    return get(null);
  }
}
