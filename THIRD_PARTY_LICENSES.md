# 第三方组件与许可证

本仓依赖的第三方组件各自按其原许可证授权；下面的许可证**不覆盖**这些组件。

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

| 组件 | 许可证 |
|---|---|
| Spring Boot（web / jdbc / validation / security / flyway / test） | Apache-2.0 |
| Flyway（含 flyway-mysql） | Apache-2.0 |
| MySQL Connector/J | GPL-2.0 with FOSS Exception |
| springdoc-openapi（Swagger UI） | Apache-2.0 |

## 运行时（不随仓分发）

| 组件 | 许可证 |
|---|---|
| JDK 21（Temurin / Homebrew openjdk） | GPL-2.0 with Classpath Exception |
| MySQL 8.0 社区版 | GPL-2.0 |
| Node.js ≥ 20 | MIT 及其依赖各自的许可证 |

## 素材

- 仓内 `assets/optimized/demo-ct-scanner.lod0.glb`、`assets/catalog/*.json` 由本项目自制，按 CC BY-NC 4.0 授权；
- 仓内不含任何第三方产品渲染图、厂商照片或厂商文档。

各许可证全文以组件自身随附的文本为准；本文件只是清单，不复制其全文。
