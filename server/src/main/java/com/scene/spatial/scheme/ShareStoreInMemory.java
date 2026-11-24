package com.scene.spatial.scheme;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * `scheme_share` 的内存实现（`spatial.store=memory`：没有 MySQL 时才用）
 *
 * 与 Jdbc 版同语义（契约测试两个实现跑同一套断言）。重启即丢 —— 所以启动时**响亮地说一遍**：
 * 不能让人以为"客户手里那条链接是好的"，其实换个进程就全没了。
 */
@Repository
@ConditionalOnProperty(name = "spatial.store", havingValue = "memory")
public class ShareStoreInMemory implements ShareStore {

  private final List<Share.Row> rows = new ArrayList<>();
  private long nextId = 1;

  public ShareStoreInMemory() {
    org.slf4j.LoggerFactory.getLogger(ShareStoreInMemory.class)
        .warn("分享口令 = **内存**（spatial.store=memory）：重启即丢，客户手里的链接会全部失效。仅用于没有 MySQL 的开发环境。");
  }

  @Override
  public synchronized Share.Row create(long schemeId, String token, LocalDateTime expiresAt,
                                       long createdBy, LocalDateTime now) {
    final Share.Row r = new Share.Row(nextId++, schemeId, token, expiresAt, false, createdBy,
        now.withNano(0));
    rows.add(r);
    return r;
  }

  @Override
  public synchronized List<Share.Row> listOf(long schemeId) {
    final List<Share.Row> out = new ArrayList<>();
    for (int i = rows.size() - 1; i >= 0; i--) {
      if (rows.get(i).schemeId() == schemeId) {
        out.add(rows.get(i));
      }
    }
    return out;
  }

  @Override
  public synchronized Optional<Share.Row> findByToken(String token) {
    for (final Share.Row r : rows) {
      if (r.token().equals(token)) {
        return Optional.of(r);
      }
    }
    return Optional.empty();
  }

  @Override
  public synchronized boolean revoke(long schemeId, long shareId) {
    for (int i = 0; i < rows.size(); i++) {
      final Share.Row r = rows.get(i);
      if (r.id() == shareId && r.schemeId() == schemeId) {
        // 已经撤过也**回 true** —— ⭐ 这是被契约测试真跑出来的事实：
        // MySQL 连接器默认回的是 **matched rows（匹配到几行）**，不是 changed rows。
        // 所以返回值说的是"这一行在不在这个方案里"，**不是**"这次动没动到"。
        // 界面要的是"现在是不是撤销态"，所以 `ShareService.revoke` **先查再判**，不靠这个返回值。
        rows.set(i, new Share.Row(r.id(), r.schemeId(), r.token(), r.expiresAt(), true,
            r.createdBy(), r.createdAt()));
        return true;
      }
    }
    return false;
  }
}