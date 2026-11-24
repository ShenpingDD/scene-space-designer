package com.scene.spatial.admin;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * `audit_log` 的内存实现（`spatial.store=memory`：无库也能起、也能跑测试）。
 *
 * 与 Jdbc 版**同形**：只增不删、新的在前。id 用自增序号 —— 测试里只关心
 * "写没写进去、顺序对不对"，不关心 id 与真实表是否一致。
 */
@Repository
@ConditionalOnProperty(name = "spatial.store", havingValue = "memory")
public class AuditLogInMemory implements AuditLog {

  private final List<Map<String, Object>> rows = new ArrayList<>();
  private long nextId = 1;

  @Override
  public synchronized void write(String actor, String action, String targetType, String targetId,
                                 String detailJson) {
    final Map<String, Object> row = new LinkedHashMap<>();
    row.put("id", nextId++);
    row.put("actor", actor);
    row.put("action", action);
    row.put("target_type", targetType);
    row.put("target_id", targetId);
    row.put("detail_json", detailJson);
    row.put("created_at", LocalDateTime.now().withNano(0));
    rows.add(row);
  }

  @Override
  public synchronized List<Map<String, Object>> listFor(String targetType, String targetId) {
    final List<Map<String, Object>> out = new ArrayList<>();
    for (int i = rows.size() - 1; i >= 0; i--) {
      final Map<String, Object> r = rows.get(i);
      if (String.valueOf(r.get("target_type")).equals(targetType)
          && String.valueOf(r.get("target_id")).equals(String.valueOf(targetId))) {
        out.add(r);
      }
    }
    return out;
  }
}
