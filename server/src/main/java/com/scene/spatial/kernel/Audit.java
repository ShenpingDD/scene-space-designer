package com.scene.spatial.kernel;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Audit.java —— R4-3：把一个方案"体检"成一份报告
 *
 * 体检 = 两件本来就并列的事（见 docs/13 接缝 A）：
 *
 * ① **放得下吗** —— {@link Validate}：越界 / 占地重叠 / 压内墙。`issues > 0` 就是摆得不对。
 * ② **用得上吗** —— {@link Clearance}（规则 7）：门实际能开多少度。它**不阻挡放置**，
 *    但"门打不开的柜子等于不能用的柜子"，`trouble` 就是给这件事计数的。
 *
 * 所以 `clean=true` 只代表"摆得合规"，不代表"用得上" —— 这两句必须分开说，
 * 否则用户会以为全绿就等于没问题（`docs/24` 实测过这种布局：合法性问题 0，门只能开 22°）。
 *
 * **只输出事实，不输出话术**：这里给的是角度、分级、被谁挡住 ——
 * 用户可见的那句话（"门最多开 62°（被 #3 挡住）"）归界面内核一份，服务端不复制第二份文案
 * （docs/21 判据④：任何重复都要写删除触发条件 —— 这里有意识地不产生重复）。
 */
public final class Audit {

  private Audit() {}

  /** 一台设备为什么放不下。`reason` 是内核原因码（`overlap-item#5` 这种带 id 的形式），话术归界面 */
  public record IssueRow(int id, String reason) {}

  /** 一台设备的门能开多少度。`freeDeg` 可为 null（没有可参与的门）—— 这种不进体检，与 JS 同口径 */
  public record DoorRow(int id, Double freeDeg, Double maxDeg, String level,
                        Clearance.Blocker blockedBy, boolean unobstructed) {}

  /** 一面墙为什么摆得不对。墙没有 id，用**序号**（与 2D 的 data-wall-index 同一套编号） */
  public record WallRow(int index, String reason) {}

  /**
   * 体检报告。`trouble` = 门开不到绿灯阈值的台数（黄 + 红），`issues` = 放不下的**台数**，
   * `wallIssues` = 摆得不对的**墙数**。
   *
   * ⚠️ 台数与墙数是两种东西，分两个字段（混着写一定会被误读 —— 这条在本项目已经付过学费）。
   * `clean` 必须**同时**看两样：墙不对也是不对。
   */
  public record Report(int items, int walls, int doors, int trouble, int issues, int wallIssues,
                       boolean clean, List<IssueRow> issueRows, List<DoorRow> doorRows,
                       List<WallRow> wallRows) {}

  public static Report of(Layout layout, Catalog catalog) {
    final List<IssueRow> issueRows = new ArrayList<>();
    for (final Layout.Item it : layout.items) {
      final String reason = Validate.checkItem(layout, it, catalog);
      if (reason != null) issueRows.add(new IssueRow(it.id, reason));
    }

    final List<DoorRow> doorRows = new ArrayList<>();
    int trouble = 0;
    for (final Layout.Item it : layout.items) {
      final Clearance.Result r = Clearance.doorFreeAngle(layout, it, catalog);
      // 没有可参与的门（含上盖式门）→ 不给数、不进体检。拒绝编造数字（与 JS clearanceReport 同口径）
      if (r.freeDeg() == null) continue;
      final String level = Clearance.clearanceLevel(r.freeDeg());
      if (!"ok".equals(level)) trouble++;
      doorRows.add(new DoorRow(it.id, r.freeDeg(), r.maxDeg(), level, r.blockedBy(), r.unobstructed()));
    }

    // B19：墙也要进结论 —— 墙摆得不对，报告就不能说 clean
    final List<WallRow> wallRows = new ArrayList<>();
    for (int i = 0; i < layout.walls.size(); i++) {
      final String r = Validate.checkWall(layout, layout.walls.get(i));
      if (r != null) wallRows.add(new WallRow(i, r));
    }

    return new Report(layout.items.size(), layout.walls.size(), doorRows.size(), trouble,
        issueRows.size(), wallRows.size(), issueRows.isEmpty() && wallRows.isEmpty(),
        issueRows, doorRows, wallRows);
  }

  /** 报告的 JSON 形状（响应用）。字段名与前端一致：`issueRows` / `doorRows` / `trouble` / `clean` */
  public static Map<String, Object> json(Report r) {
    final List<Object> issues = new ArrayList<>();
    for (final IssueRow x : r.issueRows()) issues.add(Json.obj("id", x.id(), "reason", x.reason()));

    final List<Object> doors = new ArrayList<>();
    for (final DoorRow x : r.doorRows()) {
      doors.add(Json.obj(
          "id", x.id(), "freeDeg", x.freeDeg(), "maxDeg", x.maxDeg(), "level", x.level(),
          "unobstructed", x.unobstructed(),
          "blockedBy", x.blockedBy() == null ? null
              : Json.obj("kind", x.blockedBy().kind(), "id", x.blockedBy().id())));
    }

    final List<Object> wallRowsJson = new ArrayList<>();
    for (final WallRow x : r.wallRows()) wallRowsJson.add(Json.obj("index", x.index(), "reason", x.reason()));

    return Json.obj("items", r.items(), "walls", r.walls(), "doors", r.doors(), "trouble", r.trouble(),
        "issues", r.issues(), "wallIssues", r.wallIssues(), "clean", r.clean(),
        "issueRows", issues, "doorRows", doors, "wallRows", wallRowsJson);
  }

  /** 列表页要的那几个数（不给明细：列表页不该拖几十台设备的行数据） */
  public static Map<String, Object> summary(Report r) {
    return Json.obj("items", r.items(), "issues", r.issues(), "wallIssues", r.wallIssues(),
        "trouble", r.trouble(), "clean", r.clean());
  }
}