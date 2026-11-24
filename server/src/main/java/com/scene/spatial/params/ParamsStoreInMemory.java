package com.scene.spatial.params;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * ParamsStoreInMemory —— 没库的机器上用的实现（`spatial.store=memory`）
 *
 * 与 JDBC 实现**同语义**（有契约测试同时跑两边）：`rev` 从 1 起、每次写加一，
 * 审计只追加，`lastChangedAt` 没改过就是 `null`。
 *
 * 审计这一块多一条：**`id` 从 1 起、只增不减**，列表按 `id` 倒序 ——
 * 与 JDBC 的自增主键同一个语义，否则两份实现翻出来的"第几页"会不一样。
 */
public class ParamsStoreInMemory implements ParamsStore {

  private final Map<String, Object> values = new LinkedHashMap<>();
  private final Map<String, Integer> revs = new LinkedHashMap<>();
  private final List<AuditItem> audits = new ArrayList<>();
  private LocalDateTime lastAt;
  private long nextAuditId = 1;

  @Override
  public Map<String, Object> values(String scope, String scopeId) {
    return new LinkedHashMap<>(values);
  }

  @Override
  public int put(String scope, String scopeId, String path, Object value, String valueType, Long updatedBy) {
    values.put(path, value);
    final int rev = revs.getOrDefault(path, 0) + 1;
    revs.put(path, rev);
    return rev;
  }

  @Override
  public void audit(AuditRow row) {
    final LocalDateTime at = LocalDateTime.now();
    audits.add(new AuditItem(nextAuditId++, row.path(), row.rev(), row.oldValue(), row.newValue(),
        row.changedBy(), at, row.note(), row.snapshot() == null ? Map.of() : row.snapshot()));
    lastAt = at;
  }

  @Override
  public LocalDateTime lastChangedAt(String scope, String scopeId) {
    return lastAt;
  }

  @Override
  public int countAudit(AuditQuery q) {
    return matching(q).size();
  }

  @Override
  public List<AuditItem> auditPage(AuditQuery q) {
    final List<AuditItem> desc = new ArrayList<>(matching(q));
    // 新的在前：JDBC 侧是 `ORDER BY id DESC`，这里必须翻成同一个顺序
    Collections.reverse(desc);
    final int from = Math.min(q.offset(), desc.size());
    final int to = Math.min(from + q.limit(), desc.size());
    return new ArrayList<>(desc.subList(from, to));
  }

  @Override
  public AuditItem snapshotOf(int rev) {
    // 与 JDBC 同语义：新的在前，取第一条（= id 最大那条）
    for (int i = audits.size() - 1; i >= 0; i--) {
      if (audits.get(i).rev() == rev) return audits.get(i);
    }
    return null;
  }

  @Override
  public AuditItem auditOne(long id) {
    for (final AuditItem it : audits) {
      if (it.id() == id) return it;
    }
    return null;      // 不存在就是 null，与 JDBC 的 optional().orElse(null) 同语义
  }

  /** 条件都为空就全都要；每一维都是"给 null 就是不筛"（与 JDBC 的动态 WHERE 一一对应） */
  private List<AuditItem> matching(AuditQuery q) {
    final List<AuditItem> out = new ArrayList<>();
    for (final AuditItem it : audits) {
      if (q.from() != null && (it.changedAt() == null || it.changedAt().isBefore(q.from()))) continue;
      if (q.to() != null && (it.changedAt() == null || it.changedAt().isAfter(q.to()))) continue;
      if (q.path() != null && !q.path().equals(it.path())) continue;
      if (q.changedBy() != null && !q.changedBy().equals(it.changedBy())) continue;
      out.add(it);
    }
    return out;
  }

  /** 测试用：看看留了哪些审计（老样子按行给，`id` 那些用不到） */
  public List<AuditRow> audits() {
    final List<AuditRow> out = new ArrayList<>();
    for (final AuditItem it : audits) {
      out.add(new AuditRow(it.path(), SCOPE_GLOBAL, SCOPE_ID_NONE, it.rev(),
          it.oldValue(), it.newValue(), it.snapshot(), it.changedBy(), it.note()));
    }
    return List.copyOf(out);
  }
}