/**
 * columns-3d.test.js —— P4 三维柱（独立 columnGroup + 接触阴影 + 选中 + 拾取 sentinel）
 *
 * 判据来自 设计决策记录 §三.3 / §五.8 与 设计决策记录：
 *   · 全部柱合并 **1** 份几何（12 tri/根）、接触阴影另 **1** 份（2 tri/根）；50 根 = 600 / 100 tri；
 *   · `wallMeshes === 1`、`meshes === 台数` 两条既有判据不动（柱**不并入**墙体网格）；
 *   · 柱 y ∈ [0, h]，高度跟 `layout.h`，不入库；材质与墙同源、不透明度跟墙档位；
 *   · **3D 不可点选**，但点柱必须被柱吞掉：不能穿透选中它背后的设备；
 *   · 选中高亮最多 1 个对象，由 2D/柱卡驱动（`d.selectedColumn`），真深度、不透墙。
 *
 * 几何走 `buildColumnsGeometry()`（scene3d.js 导出的纯函数）直接算；读数/接线对账走源码。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  buildColumnsGeometry, columnRect, columnsOf,
} from '../src/scene3d.js';

const SRC = readFileSync(new URL('../src/scene3d.js', import.meta.url), 'utf8');
const VIEW = readFileSync(new URL('../src/components/View3D.vue', import.meta.url), 'utf8');

const col = (id, x, z, w = 0.5, d = 0.5) => ({ id, x, z, w, d });
const near = (a, b, tol = 1e-5) => Math.abs(a - b) <= tol;   // 几何顶点是 Float32
const many = (n) => Array.from({ length: n }, (_, i) => col(i + 1, 0.5 + (i % 10) * 0.7, 0.5 + Math.floor(i / 10) * 0.7));

test('柱数据只认 layout.columns：缺省 = 空数组，绝不由 walls 反推', () => {
  assert.deepEqual(columnsOf({ walls: [{ a: [0, 0], b: [8, 0] }] }), [],
    '没有 columns 字段时必须是 0 根（旧方案不该凭空长出柱）');
  assert.deepEqual(columnsOf({}), []);
  assert.deepEqual(columnsOf(null), []);
  // 坏数据当空/丢弃，不抛（内核已经校验过；渲染层不能因为一条脏数据整片白屏）
  assert.deepEqual(columnsOf({ columns: [{ id: 1, x: 1, z: 1 }] }), [], '缺 w/d 的柱丢弃');
  assert.deepEqual(columnsOf({ columns: [{ id: 1, x: 1, z: 1, w: 0, d: 0.5 }] }), [], '0 宽丢弃');
  assert.deepEqual(columnsOf({ columns: [{ id: 1, x: 1, z: 1, w: 0.5, d: 0.5 }] }),
    [col(1, 1, 1)], '正常柱原样保留');
});

test('占地矩形与内核同口径：中心 ± 半宽/半深', () => {
  assert.deepEqual(columnRect(col(7, 4, 3, 0.6, 0.4)), [3.7, 2.8, 4.3, 3.2]);
});

test('空方案：两份几何都是 null（0 draw，不建空 mesh）', () => {
  const g = buildColumnsGeometry([], 2.8);
  assert.equal(g.body, null);
  assert.equal(g.shadow, null);
  assert.equal(g.count, 0);
  assert.equal(g.triangles, 0);
  assert.equal(g.shadowTriangles, 0);
});

test('3 根柱：柱体 1 份几何 36 tri、接触阴影 1 份几何 6 tri（12+2 每根）', () => {
  const g = buildColumnsGeometry([col(1, 2, 2), col(2, 5, 2), col(3, 5, 4.5)], 2.8);
  assert.ok(g.body instanceof THREE.BufferGeometry, '柱体必须是一份合并几何');
  assert.ok(g.shadow instanceof THREE.BufferGeometry, '接触阴影必须是一份合并几何');
  assert.equal(g.triangles, 36, '12 × 3');
  assert.equal(g.shadowTriangles, 6, '2 × 3');
  assert.equal(g.count, 3);
});

test('50 根上限：1 份柱体几何 = 600 tri、1 份阴影几何 = 100 tri（与根数无关的 2 draw）', () => {
  const g = buildColumnsGeometry(many(50), 2.8);
  assert.equal(g.count, 50);
  assert.equal(g.triangles, 600, '12 × 50');
  assert.equal(g.shadowTriangles, 100, '2 × 50');
});

test('柱 y ∈ [0, h]：底面贴地、顶面正好到层高（柱高不入库，跟 layout.h）', () => {
  const h = 3.2;
  const g = buildColumnsGeometry([col(1, 4, 3, 0.5, 0.5)], h);
  const pos = g.body.attributes.position;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    min = Math.min(min, pos.getY(i));
    max = Math.max(max, pos.getY(i));
  }
  assert.ok(near(min, 0), `柱脚必须在 y=0（不能陷进地面），实际 ${min}`);
  assert.ok(near(max, h), `柱顶必须正好到层高 ${h}，实际 ${max}`);
  // 换一个层高，几何跟着变 —— 说明没有把高度写死
  const g2 = buildColumnsGeometry([col(1, 4, 3, 0.5, 0.5)], 2.4);
  const p2 = g2.body.attributes.position;
  let max2 = -Infinity;
  for (let i = 0; i < p2.count; i++) max2 = Math.max(max2, p2.getY(i));
  assert.ok(near(max2, 2.4), `换层高后柱顶应为 2.4，实际 ${max2}`);
});

test('接触阴影：贴地 y≈0.003、法线朝上、明显比柱脚小一圈（不是第二块柱体）', () => {
  const g = buildColumnsGeometry([col(1, 4, 3, 0.5, 0.5)], 2.8);
  const pos = g.shadow.attributes.position;
  const ys = new Set();
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    ys.add(pos.getY(i));
    minX = Math.min(minX, pos.getX(i));
    maxX = Math.max(maxX, pos.getX(i));
  }
  assert.equal(ys.size, 1, '阴影是一张贴地平面（同一条 y）');
  assert.ok(near([...ys][0], 0.003), `阴影贴地 y 应≈0.003，实际 ${[...ys][0]}`);
  assert.ok(maxX - minX < 0.5 && maxX - minX > 0.4, `阴影宽度 ${maxX - minX} 应略小于柱宽 0.5`);
  const nrm = g.shadow.attributes.normal;
  assert.equal(nrm.getY(0), 1, '法线朝上（否则会被光照算成黑片）');
});

test('柱体不并入墙体网格：wallGroup 只装墙，柱自己的组只装柱', () => {
  // `wallMeshes === 1` 是用户拍板的判据；柱若并进 wallGroup，这条读数会随柱数变化
  assert.match(SRC, /columnGroup = new THREE\.Group\(\);/);
  assert.match(SRC, /columnGroup\.name = 'columns';/);
  assert.match(SRC, /columnShadowGroup\.name = 'columns-shadow';/);
  assert.match(SRC, /columnHiGroup\.name = 'columns-hi';/);
  assert.match(SRC, /columnGroup\.add\(mesh\)/, '柱体只加进柱组');
  assert.equal((SRC.match(/wallGroup\.add\(/g) || []).length, 1, 'wallGroup 只有墙那一处 add');
});

test('材质与墙同源：同色同粗糙度、不透明度跟墙档位（不新增柱专用色）', () => {
  assert.match(SRC, /color: COLORS\.wall,/);
  assert.match(SRC, /roughness: 0\.9,/);
  assert.match(SRC, /transparent: opacity < 1,\n\s+opacity,/, '不透明度跟墙档位（半透墙时柱也半透）');
  assert.equal((SRC.match(/COLORS\.wall\b/g) || []).length >= 2, true, '柱与墙共用同一个颜色常量');
  assert.doesNotMatch(SRC, /columnColor\s*:/, '不许出现柱专用颜色');
});

test('接触阴影是贴花：不写深度、有 polygonOffset、不走 shadowMap', () => {
  assert.match(SRC, /depthWrite: false,/, '接触阴影不写深度');
  assert.match(SRC, /polygonOffset: true,/);
  assert.equal(/castShadow\s*=/.test(SRC), false, '本渲染器没有 shadowMap：不许写 castShadow 假标志');
  assert.equal(/receiveShadow\s*=/.test(SRC), false);
});

test('setColumns 是增量入口：柱/层高/墙档位没变就一次几何都不重建', () => {
  assert.match(SRC, /function columnKey\(l\)/, '重建只看三件事：柱内容 / 层高 / 墙档位');
  assert.match(SRC, /if \(key === lastColumnsKey\) return lastColumns;/, '同 key 直接返回，不重建');
  // setLayout 走增量入口；柱的增删改不触发 ground/wall/route 重建
  assert.match(SRC, /buildRoutes\(l\);\n\s+setColumns\(l\);/, 'setLayout 里接的是增量 setColumns');
  const setLayoutBody = SRC.match(/function setLayout\(l\) \{[\s\S]*?\n  \}/)[0];
  assert.equal(/buildColumns\(/.test(setLayoutBody), false, 'setLayout 不许直接 buildColumns 全量重建');
  assert.match(SRC, /if \(!attached\) return lastColumns;/, '未挂载时不建也不报错');
});

test('拾取 sentinel：点柱吞掉点击 —— 不选柱、不清空选择、不穿透到背后设备', () => {
  assert.match(SRC, /function pickTargetAt\(evt\)/, '一次射线拿到"最先命中的东西"');
  assert.match(SRC, /ray\.intersectObject\(columnGroup, true\)/, '柱必须参与遮挡判定');
  assert.match(SRC, /if \(firstCol && \(!firstItem \|\| firstCol\.distance <= firstItem\.distance\)\)/,
    '谁的命中点更近谁赢（柱不吃亏）');
  assert.match(SRC, /return \{ kind: 'column'/, '命中柱返回柱的 sentinel 结果');
  // 关键：柱命中时**直接 return**，既不 onSelect(null) 也不 onSelect(id)
  assert.match(SRC, /if \(target\.kind === 'column'\) \{ renderOnce\(\); return; \}/,
    '点柱必须原地吞掉：清空选择与穿透选中背后设备都是错的');
  // 设备拾取那条老口径对柱返回 null（双击柱不该聚焦背后的柜子）
  assert.match(SRC, /return t && t\.kind === 'item' \? t\.id : null;/);
});

test('选中高亮最多 1 个对象、真深度、由外部驱动（3D 不可点选）', () => {
  assert.match(SRC, /let columnSelectedId = null;/);
  assert.match(SRC, /function setSelectedColumn\(id\)/);
  assert.match(SRC, /const line = new THREE\.LineSegments\(edges, new THREE\.LineBasicMaterial\(\{ color: COLORS\.select, depthTest: true \}\)\);/,
    '高亮是真深度的轮廓（柱在墙后不透出来）');
  assert.match(SRC, /line\.position\.set\(c\.x, h \/ 2, c\.z\)/);
  assert.equal((SRC.match(/columnHiGroup\.add\(/g) || []).length, 1, '高亮只有一个 add 点');
  assert.match(SRC, /columnSelectedId == null \|\| !layout/, '未选中/未就绪时不建高亮');
});

test('probe 读数：columnCount / columnMeshes / columnShadowMeshes / columnHiMeshes / columnTriangles', () => {
  for (const k of ['columnCount', 'columnMeshes', 'columnShadowMeshes', 'columnHiMeshes', 'columnTriangles', 'columnShadowTriangles']) {
    assert.match(SRC, new RegExp(`${k}: `), `探针缺字段 ${k}`);
  }
  // 设计决策记录的嵌套形状：墙读数一起给，探针不必记住两套路径
  assert.match(SRC, /columns: \{\n\s+columnCount: lastColumns\.count,/);
  assert.match(SRC, /wallMeshes: wallGroup\?\.children\.length \?\? 0,/);
  // 既有判据仍在：台数 = itemGroup 里的物件数
  assert.match(SRC, /meshes: itemGroup\?\.children\.length \?\? 0,/);
});

test('对外接口：setColumns / setSelectedColumn 都从 view3d 暴露出去', () => {
  assert.match(SRC, /setColumns, setSelectedColumn,/, 'devkit/View3D 要用这两个入口');
});

test('View3D 接线：watch d.selectedColumn → 3D 高亮（与 2D 同一个真源，未接上时当没选中）', () => {
  assert.match(VIEW, /function currentColumn\(\)/);
  assert.match(VIEW, /const v = d\.selectedColumn;/, '读的是 2D 那份选中态，不自己维护第二份');
  assert.match(VIEW, /'value' in v \? v\.value : \(v \?\? null\)/, 'ref 与裸值都认（2D 还没落时是 undefined）');
  assert.match(VIEW, /view3d\.setSelectedColumn\(id\)/, 'watch 里驱动 3D 高亮');
  assert.match(VIEW, /view3d\.setSelectedColumn\(currentColumn\(\)\)/, '挂载时也要同步一次（先选柱再进 3D）');
});
