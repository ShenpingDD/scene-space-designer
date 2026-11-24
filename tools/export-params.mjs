/**
 * export-params.mjs —— 把规则参数表导出成**给非 JS 侧用的数据**
 *
 * 为什么要导出：参数表是 JS 源码，但要用它的人不止 JS：
 *   · R4 的 Java 后端（同一份规则、同一份阈值）
 *   · 未来的配置管理后台（表单字段、中文名、单位、范围、说明）
 *   · 交付/评审时给人看
 * 手抄一遍是必然出错的（这个项目已经吃过三次"两份实现打架"的亏），所以**生成**。
 *
 * 用法：`node tools/export-params.mjs`（或 root 的 `npm run params`）
 * 产物（**两份，同一份内容**）：
 *   · `config/params.default.json` —— 给人看 / 给脚本用
 *   · `server/src/main/resources/params-schema.json` —— **给后端用**（`ParamsSchema` 从类路径读它）
 *
 * 为什么要第二份：后端要把规格（label/单位/范围/说明）一起发给界面表单，
 * 而它读不到仓库里的 `config/`（打成 jar 之后只有类路径）。所以让它进类路径。
 * 不这么做的话，后端就得"再抄一遍规则"——这个项目已经吃过三次两份实现打架的亏。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const { pathToFileURL } = await import('node:url');
const paramsUrl = pathToFileURL(path.join(root, 'spatial-core/src/params.js')).href;
const { defaultParams, schema, PARAM_SPEC } = await import(paramsUrl);


const out = {
  $comment: '本文件由 tools/export-params.mjs 生成，请勿手改。改参数请改 spatial-core/src/params.js 的 PARAM_SPEC。',
  generatedFrom: 'spatial-core/src/params.js',
  version: schema().version,
  defaults: defaultParams(),
  groups: schema().groups,
  flat: PARAM_SPEC.map((e) => ({ path: e.path, label: e.label, unit: e.unit, min: e.min, max: e.max, step: e.step, admin: e.admin, help: e.help, default: e.default })),
};

const target = path.join(root, 'config/params.default.json');
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log(`[params] 已导出 ${PARAM_SPEC.length} 个参数 → config/params.default.json（${(fs.statSync(target).size / 1024).toFixed(1)} KB）`);

// 第二份：**后端从类路径读**（打成 jar 之后只有类路径，读不到仓库里的 config/）。
// 不导出这一份的话，后端就得自己再抄一遍 label/范围/说明 —— 这个项目吃过三次两份实现打架的亏。
const cls = path.join(root, 'server/src/main/resources/params-schema.json');
fs.mkdirSync(path.dirname(cls), { recursive: true });
fs.writeFileSync(cls, JSON.stringify(out, null, 2) + String.fromCharCode(10));
console.log('[params] 同一份也进了后端类路径 → server/src/main/resources/params-schema.json');
