package com.scene.spatial.audit;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * AuditController —— 体检接口（R4-3）
 *
 * `POST /api/audit` 请求体 `{"state": {w,d,h,walls,items}}` → 服务端的**裁判结论**：
 *
 * ```json
 * {"ok":true,"cached":false,"costMs":141,"paramsRev":123456789,
 *  "report":{"items":7,"walls":0,"doors":7,"trouble":1,"issues":0,"clean":true,
 *            "issueRows":[], "doorRows":[{"id":4,"freeDeg":22,"maxDeg":106,"level":"bad", …}]}}
 * ```
 *
 * 为什么单独一个 `/api/audit` 而不是挂到 `/api/schemes/{id}` 上：
 * 界面上"还没保存的布局"同样需要裁判（而且最需要 —— 用户正在摆）。挂在方案 id 上就要求先存后查，
 * 那就变成"写路径上算体检"了，与 R4-2 的取舍相反。
 *
 * `GET /api/audit/stats` 是缓存自己的账本：命中率、算过多少次、上次算多久。
 * **缓存这种东西最怕安静** —— 配错了会表现成"每次请求都是冷的"，而界面上看不出区别。
 */
@RestController
@RequestMapping("/api/audit")
public class AuditController {

  private final AuditService service;

  public AuditController(AuditService service) {
    this.service = service;
  }

  /** 请求体用 record（不是裸 Map）：字段错了编译不过，缺字段由 Bean Validation 拦成 400 invalid-request */
  public record CheckRequest(@NotNull Map<String, Object> state) {}

  @PostMapping
  public Map<String, Object> check(@Valid @RequestBody CheckRequest req) {
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.putAll(service.check(req.state()));
    return out;
  }

  @GetMapping("/stats")
  public Map<String, Object> stats() {
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("stats", service.stats());
    return out;
  }
}