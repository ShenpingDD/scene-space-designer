package com.scene.spatial.admin;

import java.util.List;
import java.util.Map;

/**
 * AuditLog —— 操作日志（`audit_log`）的**唯一**存储口子。
 *
 * ## 为什么现在才抽出来
 *
 * `V9` 建表时它就在。但直到 R6-5 之前**一个调用方都没有**。第一个要留痕的动作
 * （「人工把『已交付』改回去」，A11）落地时，我把 SQL 写在交付那一侧，并留了一句话：
 *
 * > 等第二个调用方出现时再把它抽成独立的审计组件 —— 那时才看得出来它该长什么样；
 * > **现在抽就是把一个还不知道形状的东西提前定死**。
 *
 * 第二个调用方来了：**只读分享的撤销**（R6-5）。两条记录的字段一模一样，抽出来的形状
 * 就是"写一条 / 按对象列出来"这两件事 —— 也正是当时看不出来的那部分。
 * 于是 `DeliveryStore` 保留原来的方法名（**不动调用方**），但 SQL 从此只有这一份。
 *
 * ⚠️ 这张表**只增不删**（`V9` 的列注释与 `docs/32` 都这么写）。这里不提供删除与修改 ——
 * 不是"忘了做"：留痕一旦可改，它就不再是留痕。
 */
public interface AuditLog {

  /** 写一条。`detailJson` 已是 JSON 串（**不是** Map）—— 序列化在哪一侧做，由调用方决定 */
  void write(String actor, String action, String targetType, String targetId, String detailJson);

  /** 某个对象的所有留痕（新的在前） */
  List<Map<String, Object>> listFor(String targetType, String targetId);
}
