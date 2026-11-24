# 第三方组件与许可证

本仓依赖的第三方组件各自按其原许可证授权；本仓的 AGPL-3.0 / 商业授权**不覆盖**这些组件。

## 前端（`app/`）

| 组件 | 版本 | 许可证 |
|---|---|---|
| vue | ^3.5 | MIT |
| vue-router | ^4.6 | MIT |
| three | ^0.186 | MIT |
| qrcode-generator | ^2.0.4 | MIT |
| vite（构建期） | ^8.3 | MIT |
| @vitejs/plugin-vue（构建期） | ^6.0 | MIT |

## 后端（`server/`）

| 组件 | 许可证 | 备注 |
|---|---|---|
| Spring Boot（web / jdbc / validation / security / flyway / test） | Apache-2.0 | 与 AGPL-3.0 兼容 |
| Flyway（含 flyway-mysql） | Apache-2.0 | |
| MySQL Connector/J | GPL-2.0 with FOSS Exception | 见下节 |
| springdoc-openapi（Swagger UI） | Apache-2.0 | |

## 运行时（不随仓分发）

| 组件 | 许可证 |
|---|---|
| JDK 21（Temurin / Homebrew openjdk） | GPL-2.0 with Classpath Exception |
| MySQL 8.0 社区版 | GPL-2.0 |
| Node.js ≥ 20 | MIT 及其依赖各自的许可证 |

## 商业授权版注意事项

**MySQL Connector/J 是 GPL-2.0 + FOSS Exception。** 那个 Exception 只对开源项目生效，
并且把 AGPLv3 列入豁免名单 —— 所以**社区版（AGPL）没有任何问题**。
但商业版是闭源分发，Exception 不适用：把 GPLv2 的驱动打进闭源 jar，等于把整个分发也拖进 GPLv2。

商业版交付前应三选一：

1. 换成 `org.mariadb.jdbc:mariadb-java-client`（LGPL-2.1，允许被闭源程序链接，MySQL 协议兼容）；
2. 驱动不打包进 jar，由客户自行安装（体验差、售后成本高）；
3. 单独取得 Oracle 的商业授权。

在本仓的社区版里，这一项**不构成问题**，因此暂不改依赖；一旦开始对外交付商业版，
必须先处理这一条（换驱动是改动量最小的路）。

**JDK 的 Classpath Exception** 允许把 JDK 类库与你的程序一起分发而不传染 GPL —— 商业版也适用。

## 素材

- 仓内 `assets/optimized/demo-blender-001.lod0.glb`、`assets/catalog/*.json`、`docs/images/*`
  由本项目自制，按 **CC BY 4.0** 授权（见 `LICENSES/CC-BY-4.0.txt`）：署名即可，允许商用；
- 若要保留素材的商业壁垒，可只在商业版中交付素材 —— 那是分发策略，不是许可证要求；
- 仓内不含任何第三方产品渲染图、厂商照片或厂商文档；
- `app/src/assets/login/login-bg.png` 是 **AI 生成图**，文件内保留了 TC260 AIGC 隐式标识
  （`ContentProducer` 等元数据）—— 这是《人工智能生成合成内容标识办法》要求的标识，
  **请不要为了“干净”而剥掉它**；要换图就重新生成一张并保留标识。

各许可证全文以组件自身随附的文本为准；本文件只是清单，不复制其全文。
