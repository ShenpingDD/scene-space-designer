package com.scene.spatial.api;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * ApiProblem —— "可预期的问题"（业务上说得清的那种失败）
 *
 * 与"真出错了"（未捕获异常 → 500 `internal`）严格分开：
 * 前者是**规则**（方案不合法、版本冲突、东西不存在），要带**机器可读的 `reason`** 给界面分流；
 * 后者是**缺陷**，只回一句兜底 + 服务端留日志，绝不把堆栈丢给前端。
 *
 * `reason` 的取值来自内核（见 `Scheme.Error`）：`bad-room` / `bad-item` / `duplicate-id` /
 * `too-many-walls` / `bad-wall` / `not-json` / `bad-format`；接口层再补 `rev-required` /
 * `rev-conflict` / `not-found` / `bad-cover`（封面不是 PNG / 太大 / 尺寸不合常理）/
 * `bad-params`（参数不合法，`extra.errors` 带全部问题）/ `no-store`（这一档没有可写的配置存储）。
 * 界面按码给不同话术（FIX-21：别让 6 类失败共用一句话）。
 */
public class ApiProblem extends RuntimeException {

  private final int status;
  private final String reason;
  private final Map<String, Object> extra;

  private ApiProblem(int status, String reason, String message, Map<String, Object> extra) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.extra = extra == null ? Map.of() : extra;
  }

  public int status() {
    return status;
  }

  public String reason() {
    return reason;
  }

  public Map<String, Object> extra() {
    return extra;
  }

  /** 400：请求本身写错了（含方案数据不合法） */
  public static ApiProblem badRequest(String reason, String message) {
    return new ApiProblem(400, reason, message, null);
  }

  /**
   * 403：**角色不够**（维护端用）。
   *
   * 措辞上刻意说"角色"：这条判断来自登录账号的 role_code（见 {@code AdminGate}），
   * 与"没登录"（401 `unauthorized`）是两件下一步动作不同的事。
   */
  public static ApiProblem forbidden(String message) {
    return new ApiProblem(403, "forbidden", message, null);
  }

  /** 401：**没登录或会话失效**（安全链与控制器共用这一句话） */
  public static ApiProblem unauthorized(String message) {
    return new ApiProblem(401, "unauthorized", message, null);
  }

  /**
   * 401：**账号或口令不对**。
   *
   * 账号不存在与口令不对刻意共用这一句话（与分享口令那条既有纪律同源：说详细了就是在教人试）。
   */
  public static ApiProblem badCredentials() {
    return new ApiProblem(401, "bad-credentials", "账号或口令不对", null);
  }

  /** 403：账号被停用。与"口令不对"分开，因为下一步动作不同（找管理员，而不是再试一次） */
  public static ApiProblem accountDisabled() {
    return new ApiProblem(403, "account-disabled", "这个账号已停用，请联系管理员", null);
  }

  /** 403：CSRF 令牌缺失或对不上。下一步动作是刷新页面重试，与角色不足分开 */
  public static ApiProblem badCsrf() {
    return new ApiProblem(403, "bad-csrf", "跨站请求令牌缺失或不匹配：刷新页面之后重试", null);
  }

  /** 400：角色码不在四档里 */
  public static ApiProblem badRole(String message) {
    return new ApiProblem(400, "bad-role", message, null);
  }

  /** 400：这条动作会把自己关在门外（停用或删除自己） */
  public static ApiProblem selfLockout(String message) {
    return new ApiProblem(400, "self-lockout", message, null);
  }

  /** 400：这条动作会去掉最后一名管理员 */
  public static ApiProblem lastAdmin(String message) {
    return new ApiProblem(400, "last-admin", message, null);
  }

  /** 409：**撞名**（登录名已有） */
  public static ApiProblem conflict(String message) {
    return new ApiProblem(409, "conflict", message, null);
  }

  /**
   * 409：**这个账号还被别的东西占着**，物理删除被拒。
   *
   * `extra` 带四处计数（`schemes` 方案数 / `revisions` 方案版本记录数 / `shares` 分享数 /
   * `configs` 参数改动数）：界面要靠它说清"为什么删不掉"，只回一句"删不掉"等于让使用者去猜。
   * 第四处（`scheme_revision.created_by`）是老方案留下的版本记录列，它没有外键，
   * 所以必须显式数一遍 —— 靠外键挡不住的引用，只能自己数。
   */
  public static ApiProblem userInUse(Map<String, Object> counts, String message) {
    return new ApiProblem(409, "user-in-use", message, counts);
  }

  /**
   * 410 Gone：**东西存在过、现在没了**（分享口令过期 / 被撤销）。
   *
   * 为什么不用 404 顶过去：404 让人怀疑"我是不是抄错了"，410 让人去问分享人。
   * 两种情况的下一步动作不同，那就不能共用一句话（"别让 6 类失败共用一句话"的延伸）。
   */
  public static ApiProblem gone(String reason, String message) {
    return new ApiProblem(410, reason, message, null);
  }

  /** 404：不存在或已删 */
  public static ApiProblem notFound(String message) {
    return new ApiProblem(404, "not-found", message, null);
  }

  /**
   * 409：**版本冲突** —— 带上服务端当前 `rev`。
   *
   * 为什么必须带上：前端拿它才能给用户一个可操作的选择（"刷新到最新" 还是 "另存为新方案"）。
   * 只回一句"保存失败"，用户只能猜哪里错了。
   */
  public static ApiProblem revConflict(int currentRev, String message) {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("currentRev", currentRev);
    return new ApiProblem(409, "rev-conflict", message, m);
  }

  /**
   * 400：**参数不合法**。`extra.errors` 带上**全部**问题（`[{path, message}]`）。
   *
   * 为什么一次给全：界面要一次显示完（改一个报一个，用户得来回试；
   * 而且"到底还差几处"他永远不知道）。这与 JS 侧 `ParamError` 的设计是同一条。
   */
  public static ApiProblem badParams(java.util.List<Map<String, Object>> errors, String message) {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("errors", errors);
    return new ApiProblem(400, "bad-params", message, m);
  }

  /**
   * 带**更细机器码**的规则失败（产品详情/热点，设计决策记录）。
   *
   * 现有 API 的 `reason` 是粗分类（invalid-request/conflict/forbidden），
   * 这里额外给 `code`，界面可以按 `code` 定位字段，而不是解析中文。
   */
  public static ApiProblem coded(int status, String reason, String code, String message,
                                 Map<String, Object> extra) {
    final Map<String, Object> m = new LinkedHashMap<>();
    if (code != null && !code.isBlank()) m.put("code", code);
    if (extra != null) m.putAll(extra);
    return new ApiProblem(status, reason, message, m);
  }

  /** 422：保存被结构性错误拦下，一次给全 `issues[]`（设计决策记录 / §7.1） */
  public static ApiProblem contentInvalid(List<Map<String, Object>> issues, String message) {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("code", "content-invalid");
    m.put("issues", issues == null ? List.of() : issues);
    return new ApiProblem(422, "invalid-request", message, m);
  }

  /** 409：内容编辑版本过期；带当前 rev 供界面刷新后重做 */
  public static ApiProblem staleContentRev(int currentRev) {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("code", "stale-content-rev");
    m.put("currentRev", currentRev);
    return new ApiProblem(409, "conflict", "内容已被其他人改过（当前 rev=" + currentRev + "），请刷新后重做", m);
  }

  /** 404：有内容行但从未发布成功（详情接口） */
  public static ApiProblem contentNotPublished(String message) {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("code", "content-not-published");
    return new ApiProblem(404, "not-found", message, m);
  }

  /** 404：产品不存在（详情按目录 id） */
  public static ApiProblem productNotFound(String message) {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("code", "product-not-found");
    return new ApiProblem(404, "not-found", message, m);
  }

  /** `extra` 会与 `reason` / `message` 一起回给前端（如 `currentRev`） */
  public Map<String, Object> toBody() {
    final Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", false);
    body.put("reason", reason);
    body.put("message", getMessage());
    body.putAll(extra);
    return body;
  }
}