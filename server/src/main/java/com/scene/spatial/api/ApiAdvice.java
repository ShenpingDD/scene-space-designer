package com.scene.spatial.api;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.http.HttpStatusCode;
import org.springframework.web.HttpMediaTypeNotAcceptableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.ServletRequestBindingException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.MultipartException;
import org.springframework.web.server.ResponseStatusException;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * ApiAdvice —— 统一的失败出口
 *
 * 三类失败要分开对待，混在一起就是运维噩梦：
 *
 * | 类型 | 例子 | 回什么 | 记什么 |
 * | --- | --- | --- | --- |
 * | **规则**（业务上说得清） | 方案不合法、版本冲突、东西不存在 | 对应状态码 + **机器可读 reason** | 不用日志（太吵） |
 * | **请求写错**（框架挡下） | 方案名为空、超长 | 400 `invalid-request` + 字段原话 | 不用日志 |
 * | **缺陷**（真出错了） | NPE、连不上库 | 500 `internal` + 一句兜底 | **完整堆栈**，但不给前端 |
 *
 * 第三类绝不把堆栈回给前端：那既没帮用户，又漏了内部结构。
 */
@RestControllerAdvice
public class ApiAdvice {

  private static final Logger log = LoggerFactory.getLogger(ApiAdvice.class);

  /** 规则失败（见 {@link ApiProblem}） */
  @ExceptionHandler(ApiProblem.class)
  public ResponseEntity<Map<String, Object>> problem(ApiProblem p) {
    return ResponseEntity.status(p.status()).body(p.toBody());
  }

  /**
   * 请求体**根本不是合法 JSON**（也可能是非法 UTF-8）。
   *
   * 这**不是缺陷**：是客户端发错了东西，回 400 让它改。实测踩过 —— 探针从 GBK 控制台发出中文，
   * 服务端回 500「这是缺陷，不是规则失败」，把客户端的错记成了自己的账（也让前端无从下手）。
   */
  /**
   * 带状态码的规则失败（Controller 主动抛的 ResponseStatusException）。
   *
   * ⚠️ **这个坑来过三次了，病根是同一个**：4xx 落进最下面的 Exception 兜底，就变成 500。
   *    第三次（R6-3 3f）：封面的校验器抛裸 `IllegalArgumentException`，而它不认识 HTTP ——
   *    实测非法 dataUrl 回的是 500「服务端内部错误」，明明是客户端发错了。
   *    **规律**：凡"校验器只认识数据、不认识 HTTP"的地方（`Uploads` / `CoverImage` …），
   *    调用它的那**一层**都有义务把它翻成 4xx；这一步不写，就一定会变成 500，而且是静默的
   *    （谁也不会去细看一次失败请求的状态码，直到有人端到端试一遍）。
   *    上一次是 HttpMessageNotReadableException（见下面 unreadable() 的注释），
   *    这一次是 Controller 把校验失败包成 ResponseStatusException —— 端到端实测时
   *    后端其实说得清清楚楚（「缺 unit：分析器给的是 mm…」），却因为走了兜底，
   *    前端只看到「服务端内部错误」，客户端无从下手，我们还白记一堆堆栈。
   *
   * ⚠️ B4e 起这个处理里多了一条**分流**：403 回 `forbidden`、409 回 `conflict`。
   *    在此之前所有 4xx 都是 `invalid-request` —— 于是“你的角色不能发布参数”（403）
   *    在界面上的分类是“请求写错了”，正是这个门最容易被误读的那种说法。
   *
   * 这里**保留它自带的状态码**：4xx 是客户端的问题，5xx 才是我们的。日志用 warn 不用 error ——
   * 规则失败不该按缺陷记（但又不能像纯规则那样完全不记，因为它可能是被误用的信号）。
   */
  @ExceptionHandler(ResponseStatusException.class)
  public ResponseEntity<Map<String, Object>> statusException(ResponseStatusException e) {
    final HttpStatusCode code = e.getStatusCode();
    final boolean clientSide = code.is4xxClientError();
    log.warn("规则失败 {}：{}", code.value(), e.getReason());
    final Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", false);
    // 机器可读的 reason 要说**哪一类**问题，不只是“客户端错了”：
    //   401     = 没登录或会话失效（下一步是去登录页）
    //   403     = 你（这个身份）不能做这件事（B4e 的角色门就走这里，下一步是找管理员要角色）
    //   409     = 和现有数据撞了（如同名变体）
    //   其余 4xx = 请求写错了
    // 四者的**下一步动作完全不同**（登录 / 换角色 / 换名字 / 改字段），一律回 invalid-request 的话，
    // 界面只能把服务端那句话原样贴出去，自己分不清该提示什么。
    final int sc = code.value();
    final String reason = !clientSide ? "internal"
        : (sc == 401 ? "unauthorized" : (sc == 403 ? "forbidden"
            : (sc == 409 ? "conflict" : "invalid-request")));
    body.put("reason", reason);
    body.put("message", e.getReason() == null ? code.toString() : e.getReason());
    return ResponseEntity.status(code).body(body);
  }

  @ExceptionHandler(HttpMessageNotReadableException.class)
  public ResponseEntity<Map<String, Object>> unreadable(HttpMessageNotReadableException e) {
    return ResponseEntity.badRequest().body(Map.of(
        "ok", false,
        "reason", "bad-json",
        "message", "请求体不是合法 JSON（也可能不是 UTF-8）"));
  }

  /**
   * Bean Validation 挡下的请求。
   * 只把**第一条**字段提示回给前端 —— 一次说一件事，比一次列五条更好改。
   */
  @ExceptionHandler(MethodArgumentNotValidException.class)
  public ResponseEntity<Map<String, Object>> invalidRequest(MethodArgumentNotValidException e) {
    final String message = e.getBindingResult().getFieldErrors().stream()
        .findFirst()
        .map(fe -> fe.getDefaultMessage())
        .orElse("请求参数不合法");
    final Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", false);
    body.put("reason", "invalid-request");
    body.put("message", message);
    return ResponseEntity.badRequest().body(body);
  }

  /**
   * **方法不对**（拿 GET 去打一个只收 POST 的接口）—— 4xx。这是 `B13` 那一族的第五次。
   *
   * 为什么要自己翻：Spring 抛的 `HttpRequestMethodNotSupportedException` 是个普通异常，
   * 不拦就落进下面的兜底，把"你把方法写错了"回成 500"服务端内部错误（已记录日志）"——
   * 于是用户去**等一个永远不会来的修复**（与 D34 同一个病）。
   *
   * 这一族到底有多少个成员，不再靠人想 —— 机器天天在查：
   * `ApiErrorFamilyTest` 会把**所有路由**用读不懂的参数打一遍，出现 5xx 就红。
   */
  @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
  public ResponseEntity<Map<String, Object>> badMethod(HttpRequestMethodNotSupportedException e) {
    final Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", false);
    body.put("reason", "bad-method");
    body.put("message", "这个接口不收 " + e.getMethod() + " 请求（它收："
        + (e.getSupportedHttpMethods() == null ? "另一种方法" : e.getSupportedHttpMethods()) + "）");
    return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED).body(body);
  }

  /** **内容类型不对**（415）：拿 `text/plain` 发了一个只收 JSON 的接口 */
  @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
  public ResponseEntity<Map<String, Object>> badContentType(HttpMediaTypeNotSupportedException e) {
    final Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", false);
    body.put("reason", "bad-content-type");
    body.put("message", "这个接口收的是 " + e.getSupportedMediaTypes() + "，请求带的是 "
        + e.getContentType() + "（记得加 Content-Type: application/json）");
    return ResponseEntity.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE).body(body);
  }

  /** 框架自己挡下的其余 4xx（缺查询参数、缺请求部分等）—— 统一按"请求写错了"回，别掉进 500 */
  @ExceptionHandler({ServletRequestBindingException.class, HttpMediaTypeNotAcceptableException.class})
  public ResponseEntity<Map<String, Object>> badBinding(Exception e) {
    final Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", false);
    body.put("reason", "invalid-request");
    body.put("message", "请求缺东西或格式不对：" + e.getMessage());
    return ResponseEntity.badRequest().body(body);
  }

  /**
   * **不是文件上传**（拿 JSON 打了一个收 multipart 的接口）—— 400。
   *
   * 这是 `B13` 那一族的**第六次**，而且是**这条测试自己抓出来的**：
   * `ApiErrorFamilyTest` 把所有路由都用读不懂的参数打一遍，`POST /api/admin/products/upload`
   * 回了 500「服务端内部错误（请联系维护者）」—— 而它明明是"你发的东西类型不对"。
   *
   * 也就是说：这一族的成员到底有多少个，**我数不清，机器数得清**。
   */
  @ExceptionHandler(MultipartException.class)
  public ResponseEntity<Map<String, Object>> badMultipart(MultipartException e) {
    final Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", false);
    body.put("reason", "bad-multipart");
    body.put("message", "这个接口要的是文件上传（multipart/form-data）：" + e.getMessage());
    return ResponseEntity.badRequest().body(body);
  }

  /** 文件太大（`MultipartException` 的子类）—— 413，比 400 说得更准 */
  @ExceptionHandler(MaxUploadSizeExceededException.class)
  public ResponseEntity<Map<String, Object>> tooLarge(MaxUploadSizeExceededException e) {
    final Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", false);
    body.put("reason", "too-large");
    body.put("message", "文件太大，超过了服务端的上传上限。" + e.getMessage());
    return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).body(body);
  }

  @ExceptionHandler(Exception.class)
  public ResponseEntity<Map<String, Object>> internal(Exception e) {
    log.error("未预期异常（这是缺陷，不是规则失败）", e);
    final Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", false);
    body.put("reason", "internal");
    body.put("message", "服务端内部错误（已记录日志，请联系维护者）");
    return ResponseEntity.status(500).body(body);
  }

  /**
   * 没这个路由（或路径压根配不上任何 handler）—— **也是 4xx**，不是服务端崩了。
   *
   * ⚠️ 这是 `PROGRESS` 里挂着的那条 **B13**（「未知路由回 500 而不是 404」）。这轮探针把它
   * 真撞上了：`POST /api/schemes/not-a-number/delivery`（探针把 None 拼进了 URL）→ 回 500
   * `internal`，理由写着「服务端内部错误，请联系维护者」—— 而实际上是**请求写错了**。
   *
   * 为什么它比看上去严重：500 的下一步是「等人来修」，而 404 的下一步是「检查你的 URL」。
   * 把一个客户端的错报成服务端的错，会让人**去等一个永远不会来的修复**。
   */
  @ExceptionHandler(NoResourceFoundException.class)
  public ResponseEntity<Map<String, Object>> noRoute(NoResourceFoundException e) {
    final Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", false);
    body.put("reason", "not-found");
    body.put("message", "没有这个接口：" + e.getResourcePath()
        + "（检查一下路径；路径里的 id 要是数字）");
    return ResponseEntity.status(HttpStatus.NOT_FOUND).body(body);
  }

  /**
   * 路径参数读不懂（`/api/schemes/abc/delivery` 里的 `abc`）—— **这是 4xx，不是服务端出了缺陷**。
   *
   * `B13` 那一族的第四次：**凡「只认识数据、不认识 HTTP」的转换器**（这里的 `@PathVariable long`，
   * 与 `Uploads` / `CoverImage` 同一类）抛的都是框架异常，不翻就一定落进上面那个 500 兜底，
   * 把「客户端把 URL 写错了」记成「服务端崩了」—— 而 500 会让用户等一个永远不会来的修复。
   *
   * （实测：`/api/schemes/not-a-number/delivery` 走的是上面的 `NoResourceFoundException` ——
   *  Spring 在路由匹配那一步就没认它；这一条留着兜「配上了但转不动」的其余路由。）
   */
  @ExceptionHandler(MethodArgumentTypeMismatchException.class)
  public ResponseEntity<Map<String, Object>> badPathVar(MethodArgumentTypeMismatchException e) {
    final Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", false);
    body.put("reason", "bad-path");
    body.put("message", "路径参数读不懂：" + e.getName() + " = " + e.getValue()
        + "（要的是一个数字 id）");
    return ResponseEntity.badRequest().body(body);
  }
}