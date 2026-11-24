package com.scene.spatial.scheme;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * DeliveryStore —— 交付记录（`scheme_delivery`）+ 操作日志（`audit_log`）的存储口子
 *
 * ## 为什么"已交付"要落一条记录，而不是给方案加一个布尔
 *
 * 设计决策记录 §3.4 的原话：「交付记录落一张新表……这样『已交付』才是**可信状态**而不是人工勾的」。
 * 一条记录能回答四个问题：**谁**、**什么时候**、**打的哪一版**（`rev` + `params_rev` + `catalog_rev`）、
 * **包含哪些文件**（逐件 md5）。一个布尔只能回答"是/不是"，而交付这件事一旦扯皮，问的一定是前四个。
 *
 * ## 两个实现必须有同语义（`D20/D21` 的教训）
 *
 * `ParamsStore` 当年只有内存实现被断言过，JDBC 那份"从没被跑过"—— 直到契约测试补上，
 * 一跑就抓到两个真缺陷。所以这里同样是**一个接口 + 两个实现 + 一套契约断言**，
 * 连不上库时契约测试判 `skip`（不假装绿）。
 */
public interface DeliveryStore {

  /**
   * 一条交付记录。
   *
   * `filesJson` 原样是写进 `scheme_delivery.files_json` 的那段 JSON 文本
   * （`[{name,bytes,checksum}]`）—— 行对象不替调用方解析它，两个实现给的字节一致。
   */
  record DeliveryRow(long id, long schemeId, int rev, int paramsRev, long catalogRev,
                     String filesJson, boolean withAssets, String packagedBy,
                     LocalDateTime packagedAt, String note) {
  }

  /** 落一条交付记录，返回库里的那一行（**回给界面的是库里的值，不是我们以为写了什么**） */
  DeliveryRow record(long schemeId, int rev, int paramsRev, long catalogRev, String filesJson,
                     boolean withAssets, String packagedBy, String note);

  /** 某份方案的交付历史（新的在前）——「这一份交给谁过、交的是哪一版」要查得出来 */
  List<DeliveryRow> list(long schemeId);

  /**
   * 写一条操作日志（`audit_log`）。
   *
   * ⚠️ **这是 `audit_log` 的第一个写入者**（`V9` 建表至今没人写过它）。
   * 它现在住在交付这一侧，是因为第一个需要留痕的动作是「人工把『已交付』改回去」（A11）。
   * 等第二个调用方出现时再把它抽成独立的审计组件 —— 那时才看得出它该长什么样；
   * **现在抽就是把一个还不知道形状的东西提前定死**。
   */
  void writeAudit(String actor, String action, String targetType, long targetId, String detailJson);

  /** 供测试/诊断：一共几条日志（`audit_log` 的**条数**只有这一处能问） */
  List<Map<String, Object>> auditOf(String targetType, long targetId);
}