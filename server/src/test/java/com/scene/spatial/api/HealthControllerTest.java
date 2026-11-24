package com.scene.spatial.api;

import com.scene.spatial.catalog.CatalogSource;
import com.scene.spatial.kernel.Cases;
import com.scene.spatial.kernel.Catalog;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * HealthControllerTest —— `/api/health/kernel` 的 **warn 与 fail 是两档**。
 *
 * 这条接口是「服务端还是不是被断言的那份规则」的运营抓手，所以它的分档口径要钉住：
 *   · warn（目录里新加产品还没被用例覆盖）→ `warned=1`、`ok=true`（欠账可见，但不挡）；
 *   · fail（用例提到不存在的型号）→ `ok=false`（这是在给不存在的产品背书，必须红）。
 *
 * 不给 warn 单独一档的后果：要么加一款产品整片红（红久了没人看），要么永远绿（欠账看不见）。
 */
class HealthControllerTest {

  private static HealthController withCatalog(Map<String, Object> raw) {
    return new HealthController(new CatalogSource(new Catalog(raw)), "memory", "off");
  }

  @Test
  @DisplayName("目录多一款没人用过 → warned=1 / ok=true / warnedIds 点名")
  void unusedProductShowsAsWarningNotFailure() {
    final Map<String, Object> raw = new LinkedHashMap<>(Cases.CATALOG);
    raw.put("fictional-new-product", Map.of("w", 1.0, "d", 1.0));
    final Map<String, Object> out = withCatalog(raw).kernel();

    assertEquals(0, out.get("failed"), "欠账不是失败：" + out.get("failedIds"));
    assertEquals(1, out.get("warned"), "警告必须数得出来");
    assertEquals(true, out.get("ok"), "只有 fail 才影响 ok");
    assertTrue(((List<?>) out.get("warnedIds")).contains("catalog-coverage-every-product-used"),
        "要点名是哪一条：" + out.get("warnedIds"));
    assertEquals(List.of(), out.get("failedIds"));
  }

  @Test
  @DisplayName("真目录全覆盖 → warned=0 / ok=true（不许把正常状态说成警告）")
  void fullyCoveredCatalogHasNoWarning() {
    final Map<String, Object> out = withCatalog(new LinkedHashMap<>(Cases.CATALOG)).kernel();
    assertEquals(0, out.get("failed"), "真目录必须全绿：" + out.get("failedIds"));
    assertEquals(0, out.get("warned"), "全覆盖不该有警告：" + out.get("warnedIds"));
    assertEquals(true, out.get("ok"));
  }
}
