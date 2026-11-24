package com.scene.spatial;

import com.scene.spatial.catalog.DbCatalog;
import com.scene.spatial.kernel.Cases;
import com.scene.spatial.kernel.Catalog;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.Map;

/**
 * KernelConfig —— 内核要用的共享件
 *
 * 型号目录做成一个 Bean（而不是每个 Service 各 `new` 一个）：目录是不可变的只读表，
 * 但"到底有几个实例"这种事一旦说不清，就会出现"A 里改了、B 不知道"的将来版本 —— 现在就一个。
 *
 * ## 目录从哪来：**库优先，用例表兜底**
 *
 * 用例表内嵌的那一份（`Cases.CATALOG`）只有 **3 款**，而 `product` 表里有 **4 款** ——
 * 实测后果：`demo-freezer-upright`（立式低温保存箱系列）界面能摆、服务端报 `bad-item`，**保存直接被挡**。
 * 所以只要库里读得到目录就用库里的；库不可用（`--no-db`，或表还是空的）才退回用例表，
 * 并且**打日志说清用的是哪一份**（"怕安静"）。
 *
 * ⚠️ **用例表自身不受影响**：`CaseRunner` / `KernelMain` / `HealthController` 都自己
 * `new Catalog(Cases.CATALOG)`（那是夹具，35 条期望值是照着它写的）。
 * 将来若要让用例表也跑真实目录，必须连带重算期望值 —— 夹具的 `demo-freezer-chest` 占地是 0.735 m，
 * 而**声明包络 1.32 m、实测包围盒 1.665 m**，三者都不同（夹具是缩放后的合成值）。
 */
@Configuration
public class KernelConfig {

  private static final Logger log = LoggerFactory.getLogger(KernelConfig.class);

  /**
   * 用例表内嵌的目录 —— **只作兜底**，不再直接对外提供。
   *
   * 谁要"当前该用哪份目录"，一律问 {@link com.scene.spatial.catalog.CatalogSource}：
   * 它负责"库优先 / 目录变了自动重读"，这里只留一份**永不变化**的夹具给它垫底。
   * （原来这里直接返回"库优先"的结果，等于把目录**钉死在启动那一刻** —— 改目录就得重启。）
   */
  @Bean
  public Catalog caseCatalog() {
    log.info("[kernel] 用例表内嵌目录已装载（{} 款，仅作兜底）", Cases.CATALOG.size());
    return new Catalog(Cases.CATALOG);
  }
}
