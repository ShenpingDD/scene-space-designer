/**
 * plan-columns.test.js —— P4 交付：打印平面图上的柱层与读数
 *
 * 这一层只钉"纸上能不能看出有柱"，规则本身（尺寸下限、柱-墙/柱-设备/柱-洞口关系、
 * 面积怎么算）都在内核 `spatial-core/src/columns.js` 里 —— 这里**不复制**任何一条：
 *   · 几何取自 `scene2d(layout).columns`（与 `PlanView` 同一份）；
 *   · 面积取自内核 `columnAreaTotal`（不是测试里再写一遍 w×d）。
 * 所以判据是"读数与内核一致"，而不是"读数与本文件另一套实现一致"（后者等于拿实现当标准）。
 *
 * 三条口径（设计决策记录 P4）：
 *   甲、有柱 → 柱层在**墙之后、设备之前**，带打印样式，纸上清晰可见；
 *   乙、有柱 → 汇总行有「柱：N 根（占 X.XX m²）」，N 与面积都是真的；
 *   丙、无柱 → 一个字节都不多（连 `.column` 样式段都不出现），旧图原样可开。
 *
 * 变异点（怎么改会让这里红）：
 *   · 把柱塞进 `walls2d`（当墙画）→「墙 path 数不变」与「不许有 wall class 的柱路径」两条红；
 *   · 自己写面积（比如只算 0.5×0.5，或漏掉 toFixed(2)）→ 读数那条红；
 *   · 样式无条件写进 `<style>` → 无柱字节不变那条红（旧图会多一段空样式）；
 *   · 柱层画在墙下面或设备之后 → 层序那条红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { scene2d } from '../src/scene2d.js';
import { planSvg } from '../src/planSvg.js';
import { boundaryWalls } from '@core/room.js';
import { columnAreaTotal } from '@core/columns.js';

/** 场地工厂：8 × 6 的房间；柱与设备按需给 */
const layout = ({ columns, items = [] } = {}) => ({
  w: 8,
  d: 6,
  h: 2.8,
  walls: boundaryWalls(8, 6),
  items,
  ...(columns ? { columns } : {}),
});
const col = (id, x, z, w = 0.5, d = 0.5) => ({ id, x, z, w, d });
const styleRule = '.column{fill:#e6e6e6;stroke:#222;stroke-width:2.4}';

test('无柱：不加柱层、不加柱样式、不加柱读数 —— 与"显式空 columns"逐字节相同', () => {
  const plain = planSvg(layout(), { name: '测试' });
  const empty = planSvg(layout({ columns: [] }), { name: '测试' });
  assert.equal(plain, empty, 'columns 缺省与空数组必须是同一张图（旧方案导出字节不变）');
  assert.ok(!plain.includes('class="column"'), '无柱不许出现柱图元');
  assert.ok(!plain.includes(styleRule), '无柱不许写柱样式（多一段空样式就破坏字节不变）');
  assert.ok(!plain.includes('柱：'), '无柱不写「柱：0 根」——纸上没柱就是事实');
  // 旧基线的锚点：墙体样式与 summary 行还在原来的位置（改到会顺带破坏别的判据）
  assert.ok(plain.includes('.wall{stroke:#222;stroke-width:3;fill:#e9e9e9}'), '墙体打印样式保持原样');
  assert.ok(plain.includes('台设备'), '汇总行仍写着设备数');
});

test('有柱：柱层带 class/样式与内核坐标，读数的根数与面积都来自内核', () => {
  const l = layout({ columns: [col(1, 2, 2, 0.2, 0.3), col(2, 5, 4, 0.5, 0.5)] });
  const svg = planSvg(l, { name: '测试' });

  assert.equal((svg.match(/class="column"/g) || []).length, scene2d(l).columns.length, '每根柱一条 path');
  assert.equal((svg.match(/class="column"/g) || []).length, 2);
  assert.ok(svg.includes(styleRule), '柱的打印样式必须在（fill/stroke/线宽）');

  // 坐标是内核给的矩形路径（2 − 0.2/2 = 1.9，2 − 0.3/2 = 1.85），不是这里再算一遍
  assert.ok(svg.includes('d="M1.9 1.85 L2.1 1.85 L2.1 2.15 L1.9 2.15 Z"'), '柱脚矩形路径与 scene2d 一致');
  assert.deepEqual(scene2d(l).columns.map((c) => c.dPath), [
    'M1.9 1.85 L2.1 1.85 L2.1 2.15 L1.9 2.15 Z',
    'M4.75 3.75 L5.25 3.75 L5.25 4.25 L4.75 4.25 Z',
  ]);

  // 0.06 + 0.25 = 0.31 m²（两位小数）
  assert.equal(columnAreaTotal(l), 0.31);
  assert.ok(svg.includes('柱：2 根（占 0.31 m²）'), '读数：根数 + 柱脚总面积');
});

test('柱不当墙画：加柱不改墙的几何与 path 数，柱路径也不带 wall class', () => {
  const before = scene2d(layout());
  const l = layout({ columns: [col(1, 2, 2, 0.2, 0.3)] });
  const after = scene2d(l);
  assert.equal(JSON.stringify(after.walls), JSON.stringify(before.walls), '柱不能进 walls2d（房间拓扑靠墙）');
  assert.equal(after.walls.length, before.walls.length);

  const wallPathsBefore = (planSvg(layout()).match(/class="wall"/g) || []).length;
  const svg = planSvg(l);
  assert.equal((svg.match(/class="wall"/g) || []).length, wallPathsBefore, '墙 path 数不因加柱改变');
  assert.ok(!svg.includes('class="wall" d="M1.9 1.85'), '柱的矩形不许穿墙的马甲');
});

test('层序：柱在最后一条墙之后、第一台设备之前（墙不会盖掉柱，柱也不会盖掉设备）', () => {
  const l = layout({
    columns: [col(1, 6, 4, 0.5, 0.5)],
    items: [{ id: 1, p: 'demo-ct-scanner', x: 1.5, z: 1.5, r: 0 }],
  });
  const svg = planSvg(l, { name: '测试' });
  const colAt = svg.indexOf('class="column"');
  const lastWallAt = svg.lastIndexOf('class="wall"');
  const firstLabelAt = svg.indexOf('class="ilabel"');
  assert.ok(colAt > lastWallAt, '柱层必须在墙之后（否则被墙的填充吃掉）');
  assert.ok(colAt < firstLabelAt, '柱层必须在设备之前');
  assert.ok(lastWallAt >= 0 && firstLabelAt >= 0, '这个场地必须真的既有墙又有设备');
});
