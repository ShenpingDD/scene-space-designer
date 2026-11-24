package com.scene.spatial.admin;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * ProductContentAdminController —— 维护端产品详情/热点读写（V18，设计决策记录）。
 *
 * 只做三件事：角色门、取 actor、把请求交给 service。
 * 校验、事务分段、发布失败隔离全在 {@link ProductContentService} —— 控制器里不再写业务判断，
 * 否则「保存」和「发布」两条入口迟早各长一套规则。
 */
@RestController
@RequestMapping("/api/admin/products")
@ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
public class ProductContentAdminController {

  private final AdminService admin;
  private final ProductContentService content;

  public ProductContentAdminController(AdminService admin, ProductContentService content) {
    this.admin = admin;
    this.content = content;
  }

  @GetMapping("/{id}/content")
  public Map<String, Object> get(@PathVariable long id) {
    admin.requireMaintain();
    return content.adminContent(id);
  }

  @PutMapping("/{id}/content")
  public Map<String, Object> saveContent(@PathVariable long id,
                                         @RequestBody(required = false) Map<String, Object> body) {
    admin.requireMaintain();
    return content.saveContent(id, body == null ? Map.of() : body, admin.actor());
  }

  @PutMapping("/{id}/hotspots")
  public Map<String, Object> saveHotspots(@PathVariable long id,
                                          @RequestBody(required = false) Map<String, Object> body) {
    admin.requireMaintain();
    return content.saveHotspots(id, body == null ? Map.of() : body, admin.actor());
  }

  @PostMapping("/{id}/content/publish")
  public Map<String, Object> publish(@PathVariable long id,
                                     @RequestBody(required = false) Map<String, Object> body) {
    admin.requireMaintain();
    return content.publish(id, body == null ? Map.of() : body, admin.actor());
  }
}
