package com.scene.spatial.scheme;

import com.scene.spatial.admin.AuditLog;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * DeliveryStoreInMemory —— 内存实现（**仅开发档**：`spatial.store=memory`，没有 MySQL 时才用）
 *
 * 与 JDBC 实现**同语义**（契约测试两个实现跑同一套断言）：交付记录只加不改、
 * 列表 / 审计按 id 倒序、`record` 返回的行就是"库里那一行"。
 *
 * 内存档重启即丢 —— 所以它启动时会**响亮地说一遍**（与 `SchemeStoreInMemory` 同口径：
 * 不能让人以为"交付记录好好的"，其实换个进程就没了）。
 */
@Repository
@ConditionalOnProperty(name = "spatial.store", havingValue = "memory")
public class DeliveryStoreInMemory implements DeliveryStore {

  private final List<DeliveryRow> rows = new ArrayList<>();
  /** 操作日志自 R6-5 起**住在自己的组件里**（第二个调用方出现时才抽得出形状）—— 见 `AuditLog` */
  private final AuditLog audit;
  private long nextId = 1;

  public DeliveryStoreInMemory(AuditLog audit) {
    this.audit = audit;
    org.slf4j.LoggerFactory.getLogger(DeliveryStoreInMemory.class)
        .warn("交付记录 = **内存**（spatial.store=memory）：重启即丢、不落库（含 audit_log）。仅用于没有 MySQL 的开发环境。");
  }

  @Override
  public synchronized DeliveryRow record(long schemeId, int rev, int paramsRev, long catalogRev,
                                         String filesJson, boolean withAssets, String packagedBy,
                                         String note) {
    final DeliveryRow r = new DeliveryRow(nextId++, schemeId, rev, paramsRev, catalogRev, filesJson,
        withAssets, packagedBy, LocalDateTime.now(), note == null ? "" : note);
    rows.add(r);
    return r;
  }

  @Override
  public synchronized List<DeliveryRow> list(long schemeId) {
    // 新的在前 —— 与 JDBC 那条 `ORDER BY id DESC` 一一对应
    final List<DeliveryRow> out = new ArrayList<>();
    for (int i = rows.size() - 1; i >= 0; i--) {
      if (rows.get(i).schemeId() == schemeId) out.add(rows.get(i));
    }
    return out;
  }

  @Override
  public void writeAudit(String actor, String action, String targetType, long targetId,
                         String detailJson) {
    audit.write(actor, action, targetType, String.valueOf(targetId), detailJson);
  }

  @Override
  public List<Map<String, Object>> auditOf(String targetType, long targetId) {
    return audit.listFor(targetType, String.valueOf(targetId));
  }
}