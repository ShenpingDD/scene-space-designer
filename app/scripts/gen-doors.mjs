#!/usr/bin/env node
/**
 * gen-doors.mjs —— 把**验收器量出来的**门几何换算成 2D 平面图直接能用的坐标。
 *
 * 为什么要单开一步换算：
 *   实测值（models.verified.json）是**模型本地坐标**下的毫米数；
 *   平面图要的是**相对设备中心**的米数，而且必须乘上加载器那一步等比缩放
 *    （配方模型 s = min(声明/实测)，官方模型 s = 1）。
 *   这套换算只做一次、只写在一个文件里 —— 否则 2D 一套、3D 一套、后端再来一套，
 *   迟早两个口径打架（这正是 FIX-04 那类 bug 的成因）。
 *
 * 产地与消费方：
 *   输入  public/assets/catalog/products.json            （规则 6 唯一目录；sync-assets 已同步）
 *   输入  public/assets/catalog/models.verified.json     （tools/models/verify-models.py 产出）
 *   输出  src/data/doors.measured.js                     （勿手改，本脚本生成）
 *
 * 缺席即回退：目录里有、但模型还没交付（或验收器没量到门）的型号，
 *   这里**不编造**任何数字 —— 平面图那边会退回"按柜宽估"的老办法，并且是可辨识的。
 *
 *   node scripts/gen-doors.mjs
 *   （由 npm run assets = sync-assets.mjs && gen-doors.mjs 自动调用）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const CAT = resolve(APP, 'public/assets/catalog');
const OUT = resolve(APP, 'src/data/doors.measured.js');

const r5 = (v) => Math.round(v * 1e5) / 1e5;

function load(name) {
  const p = resolve(CAT, name);
  if (!existsSync(p)) throw new Error(`缺少 ${p} —— 先跑 node scripts/sync-assets.mjs`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

const products = load('products.json');
const verified = load('models.verified.json');
const byId = new Map(verified.models.map((m) => [m.productId, m]));

const out = {};
const notes = [];

for (const p of products.products) {
  const v = byId.get(p.id);
  if (!v) {
    notes.push(`${p.id}: 无验收数据 → 平面图回退估算`);
    continue;
  }
  if (!v.bboxCenterMm || !v.bboxMm) {
    notes.push(`${p.id}: 验收数据缺 bbox 中心 → 回退估算（重跑 verify-models.py）`);
    continue;
  }
  // 加载器的等比缩放：只有配方/重建模型需要兜底缩放；官方模型 1:1 进场景
  const s = v.envelopeMode === 'fit' ? v.fitScale : 1;
  if (!Number.isFinite(s) || s <= 0) {
    notes.push(`${p.id}: 缩放比不可用（${s}）→ 回退估算`);
    continue;
  }
  const [cx, , cz] = v.bboxCenterMm;        // 平面只用 x / z：加载器拿 bbox 中心把原点挪到底面中心
  const baseY = v.bboxMinMm?.[1] ?? 0;      // 竖直方向加载器是"把底面抬到 0"，所以高度 = pivot.y − bbox 底
  const doors = [];
  for (const d of v.doors ?? []) {
    if (d.status !== 'ok' || !d.pivotMm || !d.closedMinMm || !d.closedMaxMm) {
      notes.push(`${p.id}/${d.node}: 门数据不完整（${d.status}）→ 该扇门不画`);
      continue;
    }
    const item = {
      node: d.node,
      nodes: [d.node],
      axis: d.axis,
      openAngleDeg: d.angleDeg,
      // 铰链：x/z 是相对设备中心的本地偏移（米）；y 是**离地高度**（米，加载器把底面抬到 0）
      hinge: {
        x: r5((d.pivotMm[0] - cx) * s / 1000),
        y: r5((d.pivotMm[1] - baseY) * s / 1000),
        z: r5((d.pivotMm[2] - cz) * s / 1000),
      },
      // 扫掠半径（米，已折算缩放）—— 只有绕竖轴（y）的门，这个数才有"平面占位"的含义
      swing: r5(d.swingRadiusMm * s / 1000),
      // 门**自己**闭合时的轮廓（米，本地）：画闭合门扇与判定"铰链在哪一端"用
      leaf: {
        x0: r5((d.closedMinMm[0] - cx) * s / 1000), x1: r5((d.closedMaxMm[0] - cx) * s / 1000),
        z0: r5((d.closedMinMm[2] - cz) * s / 1000), z1: r5((d.closedMaxMm[2] - cz) * s / 1000),
      },
      // 这扇门的数据成色：geometryExact=False 表示压缩存储读不出，扫掠半径只是上界
      exact: d.geometryExact !== false,
      sharedAccessor: d.sharedPositionAccessor === true,
      openExtra: r5(d.openExtraMm / 1000),
    };
    // 绕竖轴的门才进平面扇形；上盖（axis=x）在平面里只画铰链线，不下发半径
    const same = doors.find(
      (o) => o.axis === item.axis && Math.abs(o.hinge.x - item.hinge.x) < 1e-3
        && Math.abs(o.hinge.z - item.hinge.z) < 1e-3 && Math.abs(o.swing - item.swing) < 1e-3,
    );
    if (same) {
      same.nodes.push(item.node);   // demo-freezer-dual 上下两扇门在平面上完全重合，合成一个
    } else {
      doors.push(item);
    }
  }
  if (!doors.length) {
    notes.push(`${p.id}: 没量到可用的门 → 回退估算`);
    continue;
  }
  out[p.id] = {
    source: v.envelopeMode,      // 1:1 | fit
    fitScale: s,
    declaredMm: { w: p.w, d: p.d },
    doors,
    trusted: doors.every((d) => d.exact) && v.bboxExact !== false,
  };
}

const header = `/**
 * doors.measured.js —— 门的**实测**几何（自动生成，勿手改）
 *
 * 生成：node scripts/gen-doors.mjs（由 npm run assets 自动调用）
 * 上游：assets/catalog/models.verified.json ← tools/models/verify-models.py ← assets/models/*.glb
 *
 * 坐标系：**相对设备中心的本地平面坐标**（米）：x = 宽方向，z = 深方向，与内核 corners() 同向。
 *   把本地点换成平面点： [x + lx·cos(r) − lz·sin(r), z + lx·sin(r) + lz·cos(r)]（r = 设备旋转角）。
 *   z 已含加载器的等比缩放；铰链位置是模型里真实的节点原点，不是"前脸左端"的猜测。
 *
 * 为什么单开一个文件：catalog.js 是"产品声明"，这里放的是"从 GLB 里量出来、再换算到平面"的几何。
 * 两个来源混在一起以后就分不清谁是声明的、谁是量出来的。平面图只读这里；三维视图直接用运行时节点。
 * doors=[] 或没这个型号 → 平面图退回"按柜宽估"，那是回退、不是等价的算法。
 */

`;

const body = `export const DOORS_MEASURED = ${JSON.stringify(out, null, 2)};

/** 取某型号已量到的门（没有则空数组 = 调用方回退估算） */
export function measuredDoors(productId) {
  return DOORS_MEASURED[productId]?.doors ?? [];
}

/** 该型号的门几何是否可信（含缩放口径）；false 时调用方应把扇形标成估值 */
export function doorsTrusted(productId) {
  return DOORS_MEASURED[productId]?.trusted === true;
}
`;

writeFileSync(OUT, header + body, 'utf8');

const lines = Object.entries(out).map(([id, v]) => {
  const ds = v.doors.map((d) => `${d.axis}轴 s=${v.fitScale} r=${d.swing}m@(${d.hinge.x},${d.hinge.z})`).join(' | ');
  return `  ${id.padEnd(7)} ${v.source.padEnd(4)} ${ds}`;
});
console.log(`[doors] 已写入 ${Object.keys(out).length} 个型号 → src/data/doors.measured.js`);
console.log(lines.join('\n'));
if (notes.length) console.log('[doors] 回退说明：\n  ' + notes.join('\n  '));
process.exit(0);