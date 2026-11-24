package com.scene.spatial.scheme;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

/**
 * ShareStore —— `scheme_share` 的存储口子（Jdbc / 内存两个实现，跑同一套契约测试）
 *
 * 与交付记录不同，这张表**可以有"撤销"这个状态变更** —— 它记的不是"发生过什么"，
 * 而是"现在还有效吗"。所以 `revoke` 是 UPDATE（改 `revoked`），不是 DELETE：
 * 记录留着，"这份口令曾经存在、后来被谁撤了"要查得到。
 */
public interface ShareStore {

  /** 建一条。`expiresAt` 为 `null` = 不过期 */
  Share.Row create(long schemeId, String token, LocalDateTime expiresAt, long createdBy,
                   LocalDateTime now);

  /** 某个方案的所有口令（新的在前）—— 含已撤销/已过期的，界面自己标 */
  List<Share.Row> listOf(long schemeId);

  Optional<Share.Row> findByToken(String token);

  /**
   * 撤销。返回 `false` 只有一种含义：**这一行不存在，或者不属于这个方案**。
   * （"本来就是撤销状态"不是 `false` —— 那件事要说给用户听，见 `ShareService.revoke`）
   */
  boolean revoke(long schemeId, long shareId);
}
