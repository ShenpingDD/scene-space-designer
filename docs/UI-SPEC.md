---
title: 界面与交互规范
type: 规范
tags: [规范, UI, 场景空间设计器, 交互, 角标]
created: 2026-09-28
updated: 2026-09-28
author: demo
status: 现行
project: scene-space-designer
---

# 界面与交互规范

> 注：正文里的 `docs/NN`（如 `docs/17 §2`）是**内部设计文档的编号锚点**，用于保留决策沿革；公开仓只随附 `docs/` 下的 6 份文档，编号对照见 `docs/00-index.md`。


> 本项目是**内网业务系统**，不是官网。规范只写真实在用的界面与交互，颜色/间距/字号一律取自
> `app/src/style.css` 实际值，每条标注来源（文件 / 行号）。读不到或需运行才能确认的一律写「待核实」。

## ① 视觉基调与主题来源

设计口径（`style.css:1-2` 注释原文）：「浅色工业风 + 工业蓝主色；平面图用 SVG（矢量、可打印、不吃 GPU）」。

### 1.1 语义色变量（`style.css` `:root`）

| 变量 | 值 | 用途 |
| --- | --- | --- |
| `--brand` | `#005caf` | 工业蓝主色：主按钮、选中态、门铰链、预览墙线 |
| `--brand-dark` | `#04628f` | 主色 hover / 暗色（旧蓝派生色，`docs/30` 注明「其余色值未动」） |
| `--brand-soft` | `#e6f2f9` | 主色浅底：hover 背景、输入框 focus outline |
| `--ink` | `#16232c` | 正文主色 |
| `--ink-2` | `#4a5c68` | 次级文字（卡片头、标签） |
| `--ink-3` | `#7b8d99` | 辅助/提示文字、占位、图例 |
| `--line` | `#d8e2e9` | 主要分隔线 / 边框 |
| `--line-2` | `#eaf0f4` | 轻分隔线 / 卡片内边框 |
| `--bg` | `#f2f5f7` | 页面背景 |
| `--panel` | `#ffffff` | 面板 / 顶栏 / 底栏背景 |

### 1.2 状态色（分级，三处共用同一套色）

| 变量 | 值 | 语义 | 使用处 |
| --- | --- | --- | --- |
| `--ok` | `#1a9e6a` | 正常 / 门能开到底 / 已保存 | 状态点 `.dot`、门分级 `lv-ok`、保存态绿 |
| `--warn` | `#c77700` | 警示 / 能开但开不到底 | `lv-warn`、`.size-note` |
| `--bad` | `#cf3b46` | 错误 / 冲突 / 基本用不上 | `lv-bad`、`.issue-list`、删除按钮 |

### 1.3 形状与字体变量

| 变量 | 值 | 用途 |
| --- | --- | --- |
| `--radius` | `10px` | 卡片 / 画布圆角 |
| `--shadow` | `0 1px 2px rgb(22 35 44 / 6%), 0 8px 24px rgb(22 35 44 / 6%)` | 卡片 / 菜单投影 |
| `--mono` | `ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace` | 尺寸、坐标、编号等数字与等宽文本 |

正文排版（`style.css` `body`）：`font: 14px/1.55 "PingFang SC", "Microsoft YaHei", "Source Han Sans SC", system-ui, sans-serif`。

### 1.4 常用间距与字号（`style.css`）

| 元素 | 值 |
| --- | --- |
| 按钮 `.btn` | 圆角 7px，padding 6px 11px |
| 小按钮 `.btn--mini` | padding 2px 8px，字号 11px |
| 卡片头 `card > header` | padding 9px 12px，字号 12px / 600 |
| 侧栏 `.rail` | padding 14px |
| 顶栏 `.header` | padding 10px 16px |
| 输入框 `.field input` | padding 6px 8px，圆角 7px，focus outline 2px `--brand-soft` |
| 分段控件 `.seg` | 圆角 7px，选中态 `aria-pressed=true` 背景 `--brand` |

## ② 布局：三栏 + 顶栏/底栏 + 断点

> 大纲写作「两区（画布 + 侧栏面板）」，实际是**三栏**（左产品轨 + 画布 + 右体检/编辑），如实记录。

骨架（`style.css` `.shell` / `.body`）：

```text
.shell  = grid rows: auto 1fr auto      → 顶栏 / 主体 / 底栏
.body   = grid columns: 296px 1fr 300px → 左栏(.rail--left) / 画布(.stage) / 右栏(.rail--right)
```

| 栏 | 宽度 | 内容 |
| --- | --- | --- |
| 左栏 `rail--left` | 296px | 空间尺寸、型号目录、内墙（`ProductRail.vue`） |
| 画布 `.stage` | 1fr（自适应） | 2D 平面图 / 3D 视图 |
| 右栏 `rail--right` | 300px | 布局体检、选中对象编辑（`Inspector.vue`） |

断点（`style.css` `@media (max-width: 1180px)`）：

| 视口 | 左栏 | 画布 | 右栏 |
| --- | --- | --- | --- |
| > 1180px | 296px | 1fr | 300px |
| ≤ 1180px | 250px | 1fr | 260px |

> 无障碍方面：**未做移动端/触屏适配验证**（原项目曾支持触屏双指，见 `docs/06` FIX-10；当前 Vue 版触屏支持**待核实**）。

## ③ 交互约定

### 3.1 缩放与平移（2D，`docs/28-ux2-zoom.md` + `viewport.js` + `PlanView.vue`）

| 交互 | 约定 |
| --- | --- |
| 缩放锚点 | **滚轮以指针为锚点**，不是画布中心（手感关键） |
| 语义 | `zoom = 1 ⟺ 界面「100%」⟺ 1 m = 64 px`（= `PX_PER_M`，`viewport.js:23`）——百分比标签必须诚实 |
| 下限 | **适配（fit）就是下限**，再缩小只会让标注变灰点 |
| 手势 | 平移：右键（主路径，与 3D OrbitControls 同套手势）/ 中键 / 空格+左键 |
| 聚焦 | 双击设备 → 放大到「占视口短边 1/3」并选中；双击空白**不动**（不猜用户想回适配） |
| 快捷键 | `+` `-` 缩放、`0` 回适配（`PlanView.vue:197-199`） |
| 光标 | 平移中 `grabbing`（`!important` 盖住设备 move 光标）；画墙 `crosshair`（`style.css`） |

### 3.2 选中态

| 对象 | 选中态 | 来源 |
| --- | --- | --- |
| 墙体 | `.wall-int.is-selected` fill `--brand-dark`；列表行 `is-selected` 边框 `--brand` + 背景 `--brand-soft` | `style.css`、`ProductRail.vue` |
| 设备 | `.item.is-selected .item-body` 描边加粗 + fill 变深 | `style.css` |

### 3.3 悬停提示

- 悬停用 **`title` 承载完整值**：型号名/尺寸可能很长，卡片内一律省略号，完整值挂 `title`（`style.css` `.product` 注释、`ProductRail.vue`）。
- hover 视觉反馈：`.product:hover` 边框 `--brand` + 阴影；`.wall-int:hover` fill `--brand`。

## ④ 角标与提示规范（本项目最独特的一条）

角标的定位不是「展示」，是**分诊**：管理员一眼看出哪条该动手。实现集中在 `server/.../admin/AdminBadges.java`，纯函数、可单测（`AdminBadgesTest` 12 条）。

### 4.1 角标分级

| 级别 | 常量 | 语义 |
| --- | --- | --- |
| `bad` | `AdminBadges.BAD` | 必须修：不修前台就是坏的 |
| `warn` | `AdminBadges.WARN` | 该修：不影响能用，但影响体验或可信度 |
| `off` | `AdminBadges.OFF` | 仅提示：状态性的，不是毛病 |

顺序即**重要度顺序**（列表上先看到「必须修的」）。示例判据（`AdminBadges.of`）：无模型→`bad`；缺缩略图→`warn`；1:1 模型尺寸未对账→`warn`；`door_verified=false`→`warn`（门型未确认）；已停用→`off`。

### 4.2 角标必须能被问出来（点开有依据）

每个角标 = `{ level, text, why }`（`AdminBadges.b()` 方法）——**`why` 是必填依据**，判据全部来自库里的**真实列**（`file_path` / `thumb_file` / `envelope_ok` / `anisotropy_ok` / `door_verified` / `status`），不许猜、不许「大概有问题」。

### 4.3 假角标比没有角标更坏；宁可少一个角标也不许假装能判

`AdminBadges.java` 类注释原文（已浓缩）：

> 「门型未确认」这个角标**曾经故意不发**：它要的 `product.door_verified` 列当时还不存在（V9 才有）。**宁可少一个角标，也不许假装能判**——假角标比没角标更坏。

判据列补上、数据回填后**才发**该角标。纪律：**判据不到位就压着不发，不要凑一个出来**。

## ⑤ 文案规范

| 规范 | 落地 | 来源 |
| --- | --- | --- |
| **单位必须出现在字段名与界面上** | 输入框标签 `长 X / m`、`宽 Z / m`、`层高 / m`、`旋转 / °（5° 一档）` | `ProductRail.vue`、`Inspector.vue` |
| 双单位口径清楚 | 卡片按 **m** 显示（与空间尺寸同口径），毫米原值挂 `title`（`${mm} × … mm`） | `ProductRail.vue` `m2()` / `mm()` |
| **筛选 / 过滤不许静默** | 服务端发现缺列会打 WARN，「不许安静」；`setPosition(不存在的id)` 吼 `console.warn` 而非静默 | `catalog.js:82`、`docs/30` §1-3 |
| **角色门必须写在界面上（不是藏起来）** | 403 措辞刻意说「角色不够」而不是「未登录」——说未登录会让人以为有登录防线，那是假的；`adminMe` 是**唯一不过门**的接口，让前端权限门能拿到「我是谁」再决定放不放行 | `api/ApiProblem.java` 注释、`api.js:85-89` |

**角色门这条的两处诚实声明**（`admin/AdminGate.java` 类注释原文）：

- 这不是安全边界，「有门」≠「安全」——挡的是**误操作**，不是攻击；认证层还没接（G1，统一身份）。
- 真正的边界等 G1 落地，届时**替换这个类的判断来源**，而不是在控制器里散着改。

## ⑥ 空状态与错误态

| 场景 | 表现 | 来源 |
| --- | --- | --- |
| 画布未开始 | `.plan-empty` 居中引导文案（「从左侧 ＋ 放入设备」） | `style.css:319`、`docs/26` |
| 占位/未实现 | `.placeholder` 虚线占位块 | `style.css:393` |
| 还没有内墙 | `「还没有内墙。用平面图左上角「＋ 画内墙」拖动添加…」` | `ProductRail.vue` |
| 无冲突 | `「没有冲突项：无重叠、无碰墙、无越界。」` | `Inspector.vue:86` |
| 未选中设备 | 引导 `「在平面图里点一台设备即可编辑…按 Q/E 旋转…」` | `Inspector.vue` |
| 后端不可用 | 目录**退回本地资产**并在头部说明来源 + 「重试」按钮（不空转、不报错白屏） | `ProductRail.vue`、`catalog.js` |
| 错误提示 | `.toast` 轻提示（原型 toast 等价物），底部居中 | `style.css` `.toast` |
| 错误话术 | 失败一律 `{ok:false, reason, message}`，界面按 `reason` 给**不同话术**（不共用一句话） | `api.js`、`kernel.js` `reasonText/reasonShort` |

## ⑦ 无障碍与键盘（做到哪写哪，不照搬 WCAG）

### 已做到

| 项 | 内容 | 来源 |
| --- | --- | --- |
| 键盘操作 | `Q/E` 旋转 5°、方向键微调 0.1 m、`Delete/Backspace` 删除、`+/-/0` 缩放、`Esc` 退出画墙/第一人称 | `PlanView.vue:189-212`、`Inspector.vue` 提示 |
| ARIA 标签 | 分段控件 `role="group" aria-label`、菜单 `role="menu"` / `role="menuitem"`、选中态 `aria-pressed` | `App.vue:64,89-101`、`style.css` `.seg` |
| 颜色非唯一信息载体 | 保存态「**文字是主信息，颜色只是辅助**（色盲、截图、打印都还得看字）」 | `docs/30` §二 |
| 焦点管理 | 快捷键依赖 svg 有焦点，`preventDefault` 后显式 `focus({preventScroll:true})` 补回 | `PlanView.vue:104`、`docs/26` |

### 待核实 / 未做到

| 项 | 状态 | 说明 |
| --- | --- | --- |
| WCAG AA 对比度审计 | **已做到（2026-10-07 起）** | 内部对比度审计脚本（驱动真浏览器扫**每个有文字的可见元素**，与它的**有效底色**（含祖先 `opacity` 混合）比，按 WCAG AA 判；最近一次 **9/9 页 · 0 处不达标**（B16 把它从「盯旧原型 CSS」改成「量真界面」，见 `docs/46`）。原文「未见对比度专项检查脚本或记录」**已不成立** |
| 全键盘 Tab 遍历 / 焦点顺序清单 | **未做到** | 只做了画布焦点一条，未系统覆盖所有交互 |
| 屏幕阅读器（VoiceOver/NVDA）验证 | **未核实** | 未见验证记录 |
| 移动端 / 触屏 | **待核实** | 原项目曾支持触屏双指（`docs/06`），当前 Vue 版未验证 |
| 减小动态/动画偏好 | **待核实** | 未见 `prefers-reduced-motion` 处理 |

> 凡上面「待核实/未做到」的，**不要**在界面或文档里宣称已支持；做到一条再补一条来源。