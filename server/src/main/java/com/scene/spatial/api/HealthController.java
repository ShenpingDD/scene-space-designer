package com.scene.spatial.api;

import com.scene.spatial.catalog.CatalogSource;
import com.scene.spatial.kernel.CaseRunner;
import com.scene.spatial.kernel.Cases;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * HealthController —— 健康检查 + **内核自检**（不是业务接口）
 *
 * 它回答两个问题，都在浏览器里一眼可查：
 *   ① `/api/health`        服务起来了吗
 *   ② `/api/health/kernel` 服务端跑的**还是不是被断言的那份规则**（用例表通过数）
 *
 * 第 ② 条是"**服务端是唯一裁判**"的运营抓手：上线后不必翻日志、不必找开发，
 * 打开这个地址就知道服务端内核与用例表是否同结论。前端版本改了、参数表改了、
 * 内核被人动过 —— 这里立刻能看出来。
 *
 * ⭐ **跑的是真目录（2026-09-30 改）**：以前这里写死 `new Catalog(Cases.CATALOG)` ——
 * 拿**用例表内嵌的 3 款**当裁判，而界面/保存路径用的是库里的 4 款。于是出现两种假绿：
 *   ① 目录里第 4 款（`demo-freezer-upright`）界面能摆、服务端报 `bad-item`，而这一页照样 22/22；
 *   ② 有人把某款的声明包络改了，这一页也照样绿（它根本没看库里那份）。
 * 现在改成问 `CatalogSource.current()`（全项目唯一的目录入口）——**裁判与界面同一份目录**，
 * 并把来源（`catalogOrigin`）与型号数（`catalogProducts`）一起报出来：
 * 「现在裁判用的是哪一份」必须说得出来。
 */
@RestController
@RequestMapping("/api/health")
public class HealthController {

  private final CatalogSource catalogs;

  /**
   * 跑的是哪一档存储（`jdbc` / `memory`）。
   *
   * ⭐ 这个字段是**给启动脚本求证用的**，不是给人看的装饰：
   * `start.sh --no-db` 会拼一个 `--spring.profiles.active=local-nodb` 交给后端，
   * 而“变量名写错”这种事**不会报错** —— 2026-10-12 之前就是：`start.sh` 传的是 `XY_PROFILE`、
   * `serve.sh` 读的是 `SPATIAL_PROFILE`，于是无库档“看着像起了、实际跑的还是连库档”，
   * 两边都不出声（A6 改名遗留）。名字对不上只能靠**读事实**发现，所以把事实摆到接口上。
   */
  private final String store;

  /**
   * 身份是从哪来的（`session` / `off`）。
   *
   * 与 `store` 同一个理由：**把事实摆到接口上**（设计决策记录 §三第 10 项）。
   * `off` 档是给「机器上没有 MySQL」那种验证场合留的一档，它取固定的本机身份 ——
   * 这件事必须一眼看得出来，不许让默认档悄悄变成不鉴权。
   */
  private final String auth;

  public HealthController(CatalogSource catalogs, @Value("${spatial.store:jdbc}") String store,
                          @Value("${spatial.auth.mode:session}") String auth) {
    this.catalogs = catalogs;
    this.store = store;
    this.auth = auth;
  }

  @GetMapping
  public Map<String, Object> health() {
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("service", "spatial-design-server");
    out.put("store", store);
    out.put("auth", auth);
    out.put("casesTotal", Cases.ALL.size());
    out.put("catalogOrigin", catalogs.origin());
    out.put("catalogProducts", catalogs.current().size());
    return out;
  }

  /**
   * 性能快照：后端自己的堆 / 元空间 / GC / 线程 / 处理器占用。
   *
   * **每次现算**（读 MXBean 是 O(1)），不缓存、不起定时任务 ——
   * 一个为了测卡顿而自己开线程定时采数的接口，本身就是新的卡顿源。
   * `tools/perf/sample.ps1` 每轮会来读一次，把服务端那一头与整机数据对到同一条时间轴上。
   */
  @GetMapping("/perf")
  public Map<String, Object> perf() {
    return PerfSnapshot.of();
  }

  /**
   * 内核自检：把用例表在服务端再跑一遍（**用当前真目录**），报通过 / 警告 / 失败 / 未移植。
   *
   * ⚠️ `warn` 与 `fail` 是**两档**：`ok` 只看 fail（有 fail 才是红）。
   *    warn 是「欠的账，要看得见但不挡」——目前只有目录覆盖那条（目录里新加的产品还没被用例用过）。
   *    把 warn 混进 fail，加一款产品就整片红，红久了就没人看；把 warn 混进 pass，欠账又永远看不见。
   */
  @GetMapping("/kernel")
  public Map<String, Object> kernel() {
    int pass = 0;
    int warn = 0;
    int fail = 0;
    int skip = 0;
    final List<String> warnedIds = new ArrayList<>();
    final List<String> failedIds = new ArrayList<>();
    final List<String> skippedIds = new ArrayList<>();
    final List<CaseRunner.Outcome> outcomes = new CaseRunner(catalogs.current()).runAll();
    for (final CaseRunner.Outcome r : outcomes) {
      switch (r.status()) {
        case "pass" -> pass++;
        case "warn" -> {
          warn++;
          warnedIds.add(r.id());
        }
        case "fail" -> {
          fail++;
          failedIds.add(r.id());
        }
        default -> {
          skip++;
          skippedIds.add(r.id());
        }
      }
    }
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", fail == 0);
    out.put("tableVersion", Cases.VERSION);
    out.put("tableTotal", Cases.ALL.size());
    out.put("total", outcomes.size());
    out.put("passed", pass);
    out.put("warned", warn);
    out.put("failed", fail);
    out.put("skipped", skip);
    out.put("warnedIds", warnedIds);
    out.put("failedIds", failedIds);
    out.put("skippedIds", skippedIds);
    // 裁判用的目录是哪一份、有几款 —— 页面要把这句话说出来（"假绿"就是这么被发现的）
    out.put("catalogOrigin", catalogs.origin());
    out.put("catalogProducts", catalogs.current().size());
    out.put("catalogVersion", catalogs.version());
    return out;
  }
}