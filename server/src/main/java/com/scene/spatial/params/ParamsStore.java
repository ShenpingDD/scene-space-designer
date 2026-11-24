package com.scene.spatial.params;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * ParamsStore —— 参数配置的持久化接缝（`app_config` + `config_revision`）
 *
 * 两个实现必须**一字不差**地同语义（JDBC / 内存），所以有一个契约测试同时跑两边 ——
 * 这跟 `SchemeStore` 是同一套做法，理由也一样：只有一份实现被测过，
 * 另一份就会在换档那天才暴露差异（而那时候没人记得它没被测过）。
 *
 * `scope` / `scope_id`：V1 建表时给多租户留了位（`global` / `project` / `customer`），
 * **v1 只用 global + 空串**。空串不用 NULL —— NULL 在唯一索引里不去重（V1 的注释写了）。
 */
public interface ParamsStore {

  String SCOPE_GLOBAL = "global";
  String SCOPE_ID_NONE = "";

  /** 一页最多几条。**上限写死在这里**：控制器就不必再防一遍，查询也翻不出整库 */
  int AUDIT_MAX_LIMIT = 200;

  /** 全部配置行的**原样值**（path → 值）。空 map = 一行都没配（不是错：那就用默认值） */
  Map<String, Object> values(String scope, String scopeId);

  /**
   * 写一项：值 + `rev` 自增 + `updated_by`。返回写入之后的 `rev`。
   *
   * `rev` 是**每项各自**的改动次数（V1 就这么建的）；参数表的**版本号**是
   * {@link ParamsFingerprint} 那个指纹，两者不是一回事，别混。
   */
  int put(String scope, String scopeId, String path, Object value, String valueType, Long updatedBy);

  /**
   * 留一条参数审计。`rev` 传**改完之后的参数版本号**（= 指纹），
   * `snapshot` 传**改完之后的整份值** —— 已存方案要靠它复现"当时是按哪版参数判的"（docs/32 §4.4）。
   */
  void audit(AuditRow row);

  /** 最后一次改动时间（界面要显示"上次发布于…"）；没改过 → null（**不拿当前时间冒充**） */
  LocalDateTime lastChangedAt(String scope, String scopeId);

  /** 一条参数审计（对应 `config_revision` 的一行） */
  record AuditRow(String path, String scope, String scopeId, int rev, Object oldValue, Object newValue,
                  Map<String, Object> snapshot, String changedBy, String note) {
  }

  /**
   * 审计查询条件（R6-4 B4c）。**字段为 null = 这一条不筛**；时间是**闭区间**。
   *
   * `limit` 的兜底放在这里而不是控制器：两个实现都要守同一条规矩，
   * 而"一页最多几条"是存储侧的事（见 {@link #AUDIT_MAX_LIMIT}）。
   */
  record AuditQuery(LocalDateTime from, LocalDateTime to, String path, String changedBy,
                    int limit, int offset) {

    public AuditQuery {
      // ⚠️ 要来的比上限多，就给**上限**（不是悄悄给个默认值）：
      // 有人写 limit=999999 是想都给我，静默砍成 50 会让他以为一共只有 50 条 ——
      // 这类静默截断是这个项目最不许犯的错之一（B4c 的契约测试第一跑就抓到了它）。
      if (limit <= 0) limit = AUDIT_MAX_LIMIT / 4;                 // 没给 / 给了个没意义的：给 50
      else if (limit > AUDIT_MAX_LIMIT) limit = AUDIT_MAX_LIMIT;   // 要多了：给上限
      if (offset < 0) offset = 0;
    }
  }

  /**
   * 审计明细（`config_revision` 一行 + 自增 `id`）。
   *
   * ⚠️ `snapshot` **只有详情才给**：一行快照就是整份 46 项，列表里带上它等于把整个审计表拖出来。
   * 列表路径上它是空 map（不是 null —— 界面上"没有快照"和"快照是空的"是两件事）。
   */
  record AuditItem(long id, String path, int rev, Object oldValue, Object newValue,
                   String changedBy, LocalDateTime changedAt, String note,
                   Map<String, Object> snapshot) {
  }

  /**
   * 按条件数**一共**几条。
   *
   * 为什么必须有一个独立的 count：界面要常驻「**显示 N / 共 M 条**（条件：…）」——
   * 没有 `M`，筛选就变成了静默筛选（用户看不出"到底还有多少条没显示"）。
   */
  int countAudit(AuditQuery q);

  /** 按条件取一页，**新的在前**（按 `id` 倒序：它单调，不会像时间那样撞在同一秒上） */
  List<AuditItem> auditPage(AuditQuery q);

  /** 取一条（含全量快照）。id 不存在 → **null**（不抛异常：界面要能说"这条不在了"） */
  AuditItem auditOne(long id);

  /**
   * 按**参数版本（指纹）**取那一版的快照（R6-4 B4d）。
   *
   * 为什么要有它：方案里存的 `params_rev` 只是一个数字 —— 要回答
   * 「这一版参数当时把 `door.openOkDeg` 定成了多少」，就必须能把**值**取回来。
   * 值只存在于两个地方：`config_revision.snapshot_json`（每一次改动后的整份值），
   * 以及**出厂默认值**（`ParamsFingerprint.defaults()`，那一个不在表里，由服务层兜）。
   *
   * ⚠️ 同一个 `rev` 可能有**多行**（改回原值、连续两次发同一版都会撞上同一个指纹）——
   * 取**最新的那一行**（`id` 最大），因为它的 `snapshot_json` 与"当前这一版"最贴近。
   * 表被清理过（A17）或那一版是手改库造出来的 → 没有行，返回 **null**，界面说"取不回来"。
   */
  AuditItem snapshotOf(int rev);
}