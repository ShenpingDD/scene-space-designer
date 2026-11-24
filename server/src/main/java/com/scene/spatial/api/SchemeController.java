package com.scene.spatial.api;

import com.scene.spatial.auth.CurrentUser;
import com.scene.spatial.scheme.CoverImage;
import com.scene.spatial.scheme.DeliveryService;
import com.scene.spatial.scheme.SchemeService;
import com.scene.spatial.scheme.ShareService;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * SchemeController —— 方案接口（契约见 设计决策记录）
 *
 * 这一层**只做 HTTP 翻译**：取字段、装响应、标状态码。
 * 业务判断在 {@link SchemeService} 与内核里 —— 界面里零业务判断，接口层同样如此，
 * 好处是改规则永远只需要改一个地方。
 *
 * 请求体用 {@link SchemeDtos} 的 record（不是 `Map`）：字段错了编译不过，
 * 校验交给 Bean Validation，OpenAPI 也能照着它生成。
 */
@RestController
@RequestMapping("/api/schemes")
public class SchemeController {

  private final SchemeService service;
  private final com.scene.spatial.admin.AdminService admin;
  private final DeliveryService delivery;
  private final ShareService shares;
  private final CurrentUser user;

  public SchemeController(SchemeService service, com.scene.spatial.admin.AdminService admin,
                          DeliveryService delivery, ShareService shares, CurrentUser user) {
    this.service = service;
    this.admin = admin;
    this.delivery = delivery;
    this.shares = shares;
    this.user = user;
  }

  /**
   * 方案列表。
   *
   * `?deleted=true` 给的是**回收站**（只含已软删的）；不传就是平时的方案库。
   * 两个是同一件事的两半，所以共用一个端点、一个参数，而不是两个端点 ——
   * 两个端点会让"要不要包含已删的"这第三种语义悄悄长出来。
   */
  @GetMapping
  public Map<String, Object> list(
      @RequestParam(name = "deleted", defaultValue = "false") boolean deleted) {
    return ok("schemes", service.list(user.id(), deleted));
  }

  @GetMapping("/{id}")
  public Map<String, Object> get(@PathVariable long id) {
    return ok(service.get(id, user.id()));
  }

  @PostMapping
  @ResponseStatus(HttpStatus.CREATED)
  public Map<String, Object> create(@Valid @RequestBody SchemeDtos.CreateRequest req) {
    admin.requireWriteSchemes();
    return ok(service.create(user.id(), req.name(), req.state()));
  }

  @PutMapping("/{id}")
  public Map<String, Object> save(@PathVariable long id, @Valid @RequestBody SchemeDtos.SaveRequest req) {
    admin.requireWriteSchemes();
    // rev 不在这里补默认值：缺失要能被判成 400 rev-required（客户端写错了），而不是 409（并发冲突）
    return ok(service.save(id, user.id(), req.rev(), req.name(), req.state(), req.note()));
  }

  /**
   * 只改方案名（验收 第二轮：顶栏方案名内联编辑）。
   *
   * 为什么是独立的 `PATCH /{id}/name`，而不是 `PUT /{id}` 带一个只有 name 的 body：
   * `PUT /{id}` 是**保存内容**（要 `rev` 做乐观锁、会写 `scheme_revision`），
   * 而改名**不是一次保存** —— 没有新版本，也没有"你手里的版本旧了"这回事。
   * 合成一个端点的话，调用方每次都得说清「这次 PUT 是改名还是存内容」—— 而他没法同时说两件
   * （与 `restore` / `cover` / `delivery-state` 拆开的同一条理由）。
   *
   * 响应与保存对齐：`{ok:true, id, name, rev}`。`rev` **原样带回、没有变化** ——
   * 前端靠它确认"改名没有产生新版本"。
   *
   * 401/403：走写方案的门（与新建/保存同一档）；不存在与别人的方案都是 404（同 {@link #save}）。
   */
  @PatchMapping("/{id}/name")
  public Map<String, Object> rename(@PathVariable long id,
                                    @Valid @RequestBody SchemeDtos.NameRequest req) {
    admin.requireWriteSchemes();
    return ok(service.rename(id, user.id(), req.name()));
  }

  @DeleteMapping("/{id}")
  public Map<String, Object> delete(@PathVariable long id) {
    admin.requireWriteSchemes();
    service.delete(id, user.id());
    return Map.of("ok", true);
  }

  /**
   * 改动留痕（每次保存一条）。
   *
   * ⚠️ 原文写「回滚等有真实需要再说」—— **R6-3 3e 那个需要到了**：
   *    所以 3e 起这个端点每行多带一份**版本摘要**（尺寸 / 台数 / 型号），
   *    回滚才有得选（见 {@code SchemeService#revisions}）。
   */
  @GetMapping("/{id}/revisions")
  public Map<String, Object> revisions(@PathVariable long id) {
    return ok("revisions", service.revisions(id, user.id()));
  }

  /**
   * 从回收站恢复。
   *
   * 路径是 `/{id}/restore` 而不是 `PUT /{id}` 加一个 `deleted` 字段：
   * 「恢复」与「保存内容」是两件事（一个动 `deleted`、一个动 `room_json` + `rev`），
   * 合成一个端点的话，调用方每次都得说清「这次 PUT 是要改内容还是要改生死」—— 而他没法同时说两件。
   */
  @PostMapping("/{id}/restore")
  public Map<String, Object> restore(@PathVariable long id) {
    admin.requireWriteSchemes();
    return ok(service.restore(id, user.id()));
  }

  /**
   * 复制一份。
   *
   * 201 而不是 200：它**真的创建了一个新资源**（新的 id），与 `POST /api/schemes` 同一性质。
   * 请求体可空（不传名字就用「<源名> 副本」）—— 但**仍然要求一个 JSON 对象**，
   * 免得「有没有带 body」变成一条隐式分支。
   */
  @PostMapping("/{id}/duplicate")
  @ResponseStatus(HttpStatus.CREATED)
  public Map<String, Object> duplicate(@PathVariable long id,
                                       @Valid @RequestBody SchemeDtos.DuplicateRequest req) {
    admin.requireWriteSchemes();
    return ok(service.duplicate(id, user.id(), req.name()));
  }

  /**
   * 回滚到历史里的某一版（用户拍板 A1：回滚前先自动存一版）。
   *
   * 为什么目标版本号在 **body 里**（`targetRev`）而不是在路径里：回滚这一个请求要同时说清**两个**版本号
   * （回到哪一版 / 手里是哪一版），一个在路径、一个在 body 的话，读代码的人极易把两个搞混 ——
   * 而搞混一次的后果是**覆盖别人的改动**。两个都放在同一层、名字都写全，是拿不准时更安全的那个选择。
   */
  @PostMapping("/{id}/rollback")
  public Map<String, Object> rollback(@PathVariable long id,
                                      @Valid @RequestBody SchemeDtos.RollbackRequest req) {
    admin.requireWriteSchemes();
    return ok(service.rollback(id, user.id(),
        req.targetRev(), req.expectRev(), req.note()));
  }

  /**
   * 按**现在的**参数复核一份已存方案（R6-4 B4d，**只读**）。
   *
   * 为什么用 POST：它不是"取资源"，是一次计算（和 `POST /api/audit` 同性质：
   * 状态进、结论出）。要 id 但不要请求体 —— 路径里带着就够了。
   *
   * 为什么**不设门**、也**不写库**：它一个字都不改（存下的那条结论是留档，不能被复核覆盖）。
   * 只读的读取路径一律不设门（与 `GET /api/params` 同口径，分权是页面层的事）。
   */
  /*
   * ⚠️ 2026-10-07：调用它的那段界面（维护端卡片上的「按现参数复核」）被用户拍板整块删掉了，
   * 所以**今天没有任何界面入口**。端点留着，是因为：
   *   ① 它只算不写（读库 + 跑一遍判定，不改任何东西）—— 留着不会说假话，也不会有人误信旧数据；
   *   ② 删接口的波及面大得多（测试、口径、将来的"按旧参数复核"需求），而收益只是少一段代码。
   * 要"复核某一版按现参数是什么结论"时，`curl -X POST /api/schemes/{id}/recheck` 仍然可用。
   */
  @PostMapping("/{id}/recheck")
  public Map<String, Object> recheck(@PathVariable long id) {
    return ok(service.recheck(id, user.id()));
  }

  /**
   * 收封面（R6-3 3f）：把浏览器刚截的三维视角存下来。
   *
   * 为什么不塞进 `PUT /{id}` 一起提交：保存内容与交封面是**两件事**，失败方式也不同 ——
   * 内容是乐观锁保护的（409 冲突要用户做选择），封面是一张图（太大/格式不对要重截）。
   * 合成一个请求的话，一次 409 会连图一起丢掉，而用户手里的图是**已经截好的**、重截要重新摆机位。
   *
   * 也不给它 `rev`：封面**不跟版本走**（用户拍板 2026-09-29），它不是一次内容编辑。
   */
  @PostMapping("/{id}/cover")
  public Map<String, Object> saveCover(@PathVariable long id,
                                       @Valid @RequestBody SchemeDtos.CoverRequest req) {
    admin.requireWriteSchemes();
    return ok(service.saveCover(id, user.id(), user.username(), req.dataUrl()));
  }

  /**
   * 下发封面。
   *
   * ## 缓存策略是这一节最要紧的东西
   *
   * 封面的文件名是**固定的**（`{id}.png`，用户拍板"新的覆盖旧的"）→ **URL 永不改变**。
   * 于是"照抄 `AssetsController` 给 immutable 长缓存"这件事在这里是**错的**：
   * 用户换了封面之后，浏览器会一直拿缓存里的旧图，而且**没有任何办法察觉**。
   * 所以这里两件事一起做：
   *   ① `Cache-Control: no-cache` —— 注意它不是"不缓存"，而是"**每次都要回源校验**"；
   *   ② `ETag` = 内容 md5（就是 `scheme.cover_checksum`，`V9` 建列时写的用途正是它）
   *      → 内容没变回 304（省流量），变了就 200 给新图。**"图变了"浏览器一定知道**。
   */
  @GetMapping("/{id}/cover")
  public ResponseEntity<byte[]> cover(@PathVariable long id,
      @RequestHeader(name = "If-None-Match", required = false) String ifNoneMatch) {
    final CoverImage.Cover c = service.readCover(id, user.id());
    if (matchesEtag(ifNoneMatch, c.md5())) {
      return ResponseEntity.status(HttpStatus.NOT_MODIFIED).eTag(c.md5()).build();
    }
    return ResponseEntity.ok()
        .contentType(MediaType.IMAGE_PNG)
        .cacheControl(CacheControl.noCache())
        .eTag(c.md5())
        .body(c.bytes());
  }

  /**
   * 生成交付包（R6-5 · A10 / A11 / A13）。
   *
   * ## 为什么响应的 body 就是 zip 本身
   *
   * 不落盘、不返回「下载地址」：交付包是**一次生成、当场带走**的东西（用户点完就要拿到文件）。
   * 服务端存一份的话就要回答「存多久、谁能下载、旧包要不要清」三个没人拍过的问题，
   * 而这三件事一旦拍错（比如旧包被人重新下载了）就是「两份图纸看起来一模一样、内容却不是一版」。
   * 交付记录（`scheme_delivery`）照样落库：**记录留下的是一份包对不对得上账，不是一个包**。
   * 包里逐件的 md5 就记在那条记录里（`files_json`）—— 想看「这一包到底是什么」，看它。
   *
   * ## 文件名要走 RFC 5987 的 `filename*`
   *
   * 方案名是中文（「冷藏库房 B 区」），旧式的 `filename=` 在浏览器上会变成乱码或被丢弃 ——
   * 所以两份都给：老的给一个 ASCII 兽名（`delivery.zip`）兼容用，真的那个给 `filename*=`。
   */
  @PostMapping("/{id}/delivery")
  public ResponseEntity<byte[]> delivery(@PathVariable long id,
      @Valid @RequestBody SchemeDtos.DeliveryRequest req) {
    // 打包是写动作（落交付记录 + 把状态置成已交付），所以走写方案的门
    admin.requireWriteSchemes();
    final DeliveryService.Packaged p = delivery.pack(id, req.expectRev(), req.items(),
        Boolean.TRUE.equals(req.withAssets()), req.note(), req.planSvg(), req.shots(),
        req.shotViews(), req.rooms());
    final String utf8 = URLEncoder.encode(p.fileName(), StandardCharsets.UTF_8).replace("+", "%20");
    return ResponseEntity.ok()
        .contentType(MediaType.parseMediaType("application/zip"))
        .header(HttpHeaders.CONTENT_DISPOSITION,
            "attachment; filename=\"delivery.zip\"; filename*=UTF-8''" + utf8)
        .body(p.zip());
  }

  /**
   * 交付历史 + 改状态留痕（同一个页面区块要看的两半，一次给齐）。
   *
   * 不设门：读取路径一律不设门（与 `GET /api/params` 同口径）。
   */
  @GetMapping("/{id}/deliveries")
  public Map<String, Object> deliveries(@PathVariable long id) {
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("deliveries", delivery.deliveries(id));
    out.put("stateChanges", delivery.stateHistory(id));
    // 状态徽标要在**打开面板那一刻**就有（否则会先显示一句「（没有状态）」，看着像坏了）
    out.put("status", delivery.statusOf(id));
    // 可勾选的件清单 + 三个固定视角：**服务端下发，界面不抄**（抄一份就会在改词表那天漏掉一边）
    out.put("items", delivery.itemRegistry());
    out.put("views", delivery.viewRegistry());
    return ok(out);
  }

  /**
   * 人工改交付状态（A11 后半句：允许人工改回，但要说清为什么）。
   *
   * 它是写动作（改状态 + 写 `audit_log`），所以走写方案的门 —— 与自动置位同一档权力。
   */
  @PostMapping("/{id}/delivery-state")
  public Map<String, Object> deliveryState(@PathVariable long id,
      @Valid @RequestBody SchemeDtos.DeliveryStateRequest req) {
    admin.requireWriteSchemes();
    return ok(delivery.setState(id, req.status(), req.note()));
  }

  // ───────────────────── 只读分享（R6-5 · 设计决策记录）─────────────────────

  /**
   * 生成一条免登录的只读链接。
   *
   * 三个动作都要写方案的门：**口令是凭据**（谁拿到谁就能看方案），不是"关于方案的说明"。
   * `viewer` 能看方案本身，但看不到、也发不出别人手里的口令。
   *
   * `days` 缺省 = 30 天；三档 = **7 / 30 / 不过期**（`Share.DAY_CHOICES`，界面照它渲染，不自己写一份）。
   *
   * ⚠️ 「不过期」这一档**改过一次拍板**（原先刻意不给）：一条永不失效的免登录链接，
   * 只在有人记得它存在的时候才是安全的 —— 用户 2026-10-08 决定提供。
   * 于是口令位数必须够（**8 位，不能是 6 位**），理由与账在 设计决策记录 §12.2 / §12.3。
   *
   * 另外：**一个方案只留一条有效链接** —— 建新的会先把旧的撤掉（见 `ShareService` 类注释）。
   */
  @PostMapping("/{id}/share")
  public Map<String, Object> share(@PathVariable long id,
      @RequestBody(required = false) SchemeDtos.ShareRequest req) {
    admin.requireWriteSchemes();
    return ok(shares.create(id, req == null ? null : req.days()));
  }

  /**
   * 这份方案的**全部**口令（含已过期 / 已撤销 —— 服务端不替界面筛，界面自己标）。
   *
   * ⚠️ 读口令要写方案的门（与生成/撤销同一档）—— 里面**带着完整口令**，
   * 它是凭据。交付记录那种"只读信息"可以不加门，这一条不行。
   */
  @GetMapping("/{id}/shares")
  public Map<String, Object> sharesOf(@PathVariable long id) {
    admin.requireWriteSchemes();
    return ok(shares.listOf(id));
  }

  /**
   * 撤销一条口令。`note` 选填 —— 写了就进 `audit_log`（"为什么撤"以后一定会有人问）。
   *
   * 已经撤过的再撤一次**不报错**：他要的结果已经在了（与 `restore` 那条纪律同源）。
   */
  @PostMapping("/{id}/share/{shareId}/revoke")
  public Map<String, Object> revokeShare(@PathVariable long id, @PathVariable long shareId,
      @RequestBody(required = false) SchemeDtos.RevokeRequest req) {
    admin.requireWriteSchemes();
    return ok(shares.revoke(id, shareId, req == null ? null : req.note()));
  }

  /**
   * 比对 `If-None-Match` 与内容的 md5。
   *
   * 归一化掉三种写法：`"abc"`（带引号，浏览器回的就是这个）、`abc`、
   * 以及 `W/"abc"`（弱校验，某些代理会这么写）。**比的是值，不是格式** ——
   * 因为格式对不上时我们只会"多回一次 200"，而值判错会导致"一直给旧图"。
   */
  private static boolean matchesEtag(String ifNoneMatch, String md5) {
    if (ifNoneMatch == null || md5 == null || md5.isEmpty()) return false;
    return ifNoneMatch.replace("W/", "").replace("\"", "").trim().equals(md5);
  }

  /** 统一响应外壳：`{"ok":true, ...}`；失败由 {@link ApiAdvice} 输出 `{"ok":false,"reason":...}` */
  private static Map<String, Object> ok(Map<String, Object> data) {
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.putAll(data);
    return out;
  }

  private static Map<String, Object> ok(String key, Object value) {
    return ok(Map.of(key, value));
  }
}