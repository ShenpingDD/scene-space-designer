package com.scene.spatial.api;

import com.scene.spatial.admin.AdminService;
import com.scene.spatial.params.ParamsService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * ParamsController —— 规则参数（R6-4 B4a）
 *
 * ## 两边的门不一样，这是刻意的
 *
 * - `GET /api/params`：**不设门**。前台设计器也要这份值 —— 参数一改，前台判定就得跟着变，
 *   否则"后台能配"只是看着能配（设计决策记录的生效链路）。
 *   所以它给的是**规格 + 当前值**，不含任何敏感信息（"这个系统怎么判的"本来就是业务方的规则）。
 * - `PUT /api/params`：**必过"发布参数"这一道门**（`requirePublishParams`，只有 admin）。
 *   前端把入口藏起来不算门 —— 门必须在后端守（`AdminService` 的注释也是这么写的）。
 *   注意门的形状：B4e 起不再问"是不是维护端角色"，而是问"能不能做这件事"（见 `AdminGate`）。
 *
 * 认证还没接（G1），这一道挡的是**误操作**，不是攻击。这个区别写在 403 的措辞里。
 */
@RestController
@RequestMapping("/api/params")
public class ParamsController {

  private final ParamsService service;
  private final AdminService admin;

  public ParamsController(ParamsService service, AdminService admin) {
    this.service = service;
    this.admin = admin;
  }

  /** 规格 + 当前生效值 + 版本 + 来源 + 被拒绝的库值 + 上次发布时间 */
  @GetMapping
  public Map<String, Object> get() {
    return service.view();
  }

  /**
   * 发布一份参数补丁。校验不通过 → 400，**带上全部问题**（界面一次显示完，
   * 而不是"改一个报一个"；理由与 JS 侧 `ParamError` 一样）。
   */
  @PutMapping
  public Map<String, Object> publish(@Valid @RequestBody ParamsDtos.PublishRequest req) {
    admin.requirePublishParams();
    return service.publish(req.patch() == null ? Map.of() : req.patch(), req.note(), admin.me());
  }

  /**
   * 按**参数版本（指纹）**取那一版的值（R6-4 B4d，**只读**）。
   *
   * 「这份方案是按 rev X 摆的」这句话要能落到**值**上：那一版把 `door.openOkDeg` 定成了多少。
   * 三种来源各说各的（出厂值 / 留痕快照 / 取不回来），**不拿现在的值冒充**
   * （见 `ParamsService.snapshot`）。
   *
   * ⚠️ 2026-10-07：界面上的调用点（维护端卡片的"参数差在哪几项"）被整块删掉了，
   * 今天没有 UI 入口。端点留着：它**只读**，而且是"某一版参数到底长什么样"的唯一读法
   * （排查"这份方案为什么判成这样"时要用它）。删掉它等于把这条排查路径也删了。
   */
  @GetMapping("/snapshot/{rev}")
  public Map<String, Object> snapshot(@PathVariable int rev) {
    return withNames(service.snapshot(rev));
  }

  /**
   * **只问版本，不问内容**（前台自动跟新的轮询口）。
   *
   * ## 为什么要单独开一个口，而不是让前台反复拉 `GET /api/params`
   * 整份 `/api/params` 带着 46 项规格（约 31 KB，M1a 后实测）。前台要「后台一改，我这边跟上」，
   * 那就得反复问；每 5 秒拉 12 KB 只为看一个数字，是白花的流量。
   * 这个口只有三个字段（几十字节）：**先问版本、变了才取内容**。
   *
   * 同样**不设门**：它不含任何敏感信息（一个整数），而前台必须能问。
   */
  @GetMapping("/rev")
  public Map<String, Object> rev() {
    return Map.of(
        "ok", true,
        "rev", service.rev(),
        "changed", service.changedCount());
  }

  /**
   * 参数审计（R6-4 B4c）：回答「**谁、什么时候、把哪一项从多少改成多少、为什么**」。
   *
   * 读端**不设门** —— 与 `GET /api/params` 同一口径：门在写端（`PUT`）才有意义。
   * 挡在读端挡不住任何东西（当前值本来就是放开的），只会让审计变成"只有维护端能看"，
   * 而审计恰恰是**越多人看越好**的东西。真要按角色分权，A14 的四档门在页面层统一做（B4e）。
   */
  @GetMapping("/revisions")
  public Map<String, Object> revisions(
      @RequestParam(name = "from", required = false) String from,
      @RequestParam(name = "to", required = false) String to,
      @RequestParam(name = "key", required = false) String key,
      @RequestParam(name = "by", required = false) String by,
      @RequestParam(name = "limit", required = false, defaultValue = "50") int limit,
      @RequestParam(name = "offset", required = false, defaultValue = "0") int offset) {
    return withNames(service.audit(from, to, key, by, limit, offset));
  }

  /** 一条审计的详情（含**全量快照**：B4d 要用它复现"当时是按哪版参数判的"） */
  @GetMapping("/revisions/{id}")
  public Map<String, Object> revision(@PathVariable("id") long id) {
    return withNames(service.auditOne(id));
  }

  /**
   * 把 `changed_by`（用户 id）补上显示名。
   *
   * 查不到名字时**留空**，由界面显示原始 id —— **不补假名字**（审计里最不能容忍的就是猜）。
   * 这件事放在控制器做（而不是 Service）：参数这一层不该认识 `sys_user`。
   */
  private Map<String, Object> withNames(Map<String, Object> out) {
    final Map<String, String> names = admin.userNames();
    if (out.containsKey("changedBy")) {
      out.put("changedByName", names.getOrDefault(String.valueOf(out.get("changedBy")), ""));
    }
    final Object rows = out.get("rows");
    if (rows instanceof List<?> list) {
      for (final Object o : list) {
        if (o instanceof Map<?, ?> r) {
          @SuppressWarnings("unchecked")
          final Map<String, Object> row = (Map<String, Object>) r;
          row.put("changedByName", names.getOrDefault(String.valueOf(row.get("changedBy")), ""));
        }
      }
    }
    return out;
  }

  /** 供界面显示"能不能改"的最小信息（不改 role_code 的来源，只转发一次判断） */
  @GetMapping("/whoami")
  public Map<String, Object> whoami() {
    final Map<String, Object> me = admin.me();
    return Map.of(
        "ok", true,
        "canPublish", Boolean.TRUE.equals(me.get("isAdmin")),
        "roleCode", me.get("roleCode") == null ? "" : me.get("roleCode"),
        "displayName", me.get("displayName") == null ? "" : me.get("displayName"));
  }
}