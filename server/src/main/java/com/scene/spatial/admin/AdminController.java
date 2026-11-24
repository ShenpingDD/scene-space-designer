package com.scene.spatial.admin;

import com.scene.spatial.scheme.DeliveryService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * AdminController —— 维护端 · 我是谁 + 系统状态（R6-1）
 *
 * 为什么 `/me` **不**过角色门：前端的权限门要靠它来决定"让不让进"。
 * 连"我是谁"都问不到的话，界面就只能猜 —— 猜出来的权限迟早是错的。
 * 它只回自己的身份与角色，回的内容本身就是"你无权"的答案（isAdmin=false）。
 * 它仍然**要求已登录**（安全链挡在更前面）：身份来自登录账号，不是谁问都给。
 */
@RestController
@RequestMapping("/api/admin")
public class AdminController {

  private final AdminService admin;
  private final DeliveryService delivery;

  public AdminController(AdminService admin, DeliveryService delivery) {
    this.admin = admin;
    this.delivery = delivery;
  }

  /** 身份 + 角色 + 四档能力表（U1 起身份来自登录会话：`authLanded: true`） */
  @GetMapping("/me")
  public Map<String, Object> me() {
    return admin.me();
  }

  /** 系统状态：每一个数都能核对（含迁移版本 —— Flyway 重号会让服务起不来） */
  @GetMapping("/system")
  public Map<String, Object> system() {
    admin.requireEnterAdmin();
    return admin.system();
  }

  /**
   * 型号使用情况（R6-5 验收判据③：「**从未被使用的型号**能在统计里查出来」）。
   *
   * 为什么算它在维护端而不是设计器：它回答的是「**目录里为什么放着这一款**」——
   * 没人用过的型号就是在占位置（要么补文案、要么下架）。摆东西的人不需要看这个数。
   *
   * 与 `/system` 同一道门（要能进维护端）；它**只读**，一个字都不写。
   */
  @GetMapping("/product-usage")
  public Map<String, Object> productUsage() {
    admin.requireEnterAdmin();
    return delivery.usage();
  }
}
