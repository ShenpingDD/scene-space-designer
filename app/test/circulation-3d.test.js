/**
 * circulation-3d.test.js —— P3 三维动线（贴地 ribbon + 箭头 + 遮挡 + 第一人称自由）
 *
 * 这一层测的是**几何/读数**，不是像素：几何用 `buildRouteGeometry()`（scene3d.js 导出的纯函数）
 * 直接算，读数用源码里的探针字段/材质参数对账。真机可见性另有一条 cdp 探针。
 *
 * 判据来自 设计决策记录 / §7.1 与 task-46：
 *   · 所有 ribbon 合并 1 份几何、箭头合并 1 份；选中高亮最多 +1；`wallMeshes === 1` 不动；
 *   · 失效路线**不产生三角形**（不画假线）；
 *   · 动线不参与第一人称碰撞/不拉回 —— 走路的代码里不许出现 route；
 *   · 颜色按路线序号派生（index → 颜色数组），三维不维护第二套色表；
 *   · 读数 `routeMeshes / routeTriangles / routeCount / routeStatus` 必须在探针里。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { boundaryWalls } from '@core/room.js';
import { mkWallSeg } from '@core/wall.js';
import { planRoutes, segmentWalkable } from '@core/route.js';
import { buildRouteGeometry, cssColor, routePathPoints } from '../src/scene3d.js';
import { routes2d } from '../src/scene2d.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const APP = new URL('../src/', import.meta.url);
const read = (p) => readFileSync(new URL(p, APP), 'utf8');

const W = (x, z, xx, zz, openings) => mkWallSeg(x, z, xx, zz, openings || []);
const door = (w = 0.9) => ({ at: 3, w, h: 2.1 });
const getProduct = () => undefined;

/** 8×6 场景 + 可选内墙；routes 是冻结格式里的用户点（只读） */
const scene = (routes, extraWalls = []) => ({
  w: 8, d: 6, h: 2.8,
  walls: [...boundaryWalls(8, 6), ...extraWalls],
  items: [],
  routes,
});

test('几何：有效路线 = 1 份 ribbon + 1 份箭头；失效路线一个三角形都不产生', () => {
  // 两个布局：有门 → 可走；无门内墙 → 不可走（用同一对站点，差异只在布局）
  const route = { id: 1, name: '主动线', points: [[2, 3], [6, 3]] };
  const withDoor = scene([{ ...route }], [W(4, 0, 4, 6, [door()])]);
  const noDoor = scene([{ ...route }], [W(4, 0, 4, 6)]);
  const planned = [planRoutes(withDoor, { getProduct })[0], planRoutes(noDoor, { getProduct })[0]];
  assert.equal(planned.length, 2);
  assert.equal(planned[0].ok, true, '过门的路线必须可走');
  assert.equal(planned[1].ok, false, '不过门的路线必须判失效（不穿墙）');
  assert.deepEqual(planned[1].legs, [], '失效结果不返回半条假折线');

  const colors = [new THREE.Color(1, 0, 0), new THREE.Color(0, 1, 0)];
  const g = buildRouteGeometry(planned, { colors });
  assert.ok(g.ribbon instanceof THREE.BufferGeometry, 'ribbon 必须是一份合并几何');
  assert.ok(g.arrows instanceof THREE.BufferGeometry, 'arrows 必须是一份合并几何');
  assert.equal(g.valid, 1);
  assert.equal(g.invalid, 1);
  assert.equal(g.markers, 2, '只有有效路线的起点/终点有标记；失效路线不画假标记');
  assert.ok(g.triangles > 0);
  // 颜色取自传入的按序号派生的色表（第一段 = 红色）
  const col = g.ribbon.getAttribute('color');
  assert.ok(Math.abs(col.getX(0) - 1) < 1e-6 && Math.abs(col.getY(0)) < 1e-6 && Math.abs(col.getZ(0)) < 1e-6);

  // 失效路线不画假线：与「只算有效路线」的三角形数完全一致
  const onlyValid = buildRouteGeometry([planned[0]], { colors });
  assert.equal(g.triangles, onlyValid.triangles);
});

test('几何：箭头朝向 = 行进方向，ribbon 带宽 0.08 m（方向不依赖颜色也读得出）', () => {
  // 一条朝 +x 的直线路线：fail 掉任何"箭头转反/宽度漂移"的改动
  const l = scene([{ id: 1, name: '直线', points: [[1, 3], [5, 3]] }]);
  const planned = planRoutes(l, { getProduct });
  assert.equal(planned[0].ok, true);
  const g = buildRouteGeometry(planned, { colors: [new THREE.Color(0.2, 0.5, 0.9)], markers: false });
  const pos = g.ribbon.getAttribute('position');
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < pos.count; i += 1) { minZ = Math.min(minZ, pos.getZ(i)); maxZ = Math.max(maxZ, pos.getZ(i)); }
  assert.ok(Math.abs((maxZ - minZ) - 0.08) < 1e-6, `ribbon 带宽应为 0.08 m，实测 ${(maxZ - minZ).toFixed(4)}`);
  const ap = g.arrows.getAttribute('position');
  assert.ok(ap.count >= 3, '直线路线必须至少有一个箭头');
  for (let i = 0; i + 2 < ap.count; i += 3) {
    // 每个三顶点 = 一个箭头；tip（第 1 个顶点）在 +x 方向最前
    assert.ok(ap.getX(i) > ap.getX(i + 1) && ap.getX(i) > ap.getX(i + 2),
      `箭头必须指向行进方向（+x），实测 tip ${ap.getX(i)} vs base ${ap.getX(i + 1)},${ap.getX(i + 2)}`);
  }
});

test('几何：三维走 plan.legs 的真实折线，不拿用户锚点直连穿墙；起点/途经点有标记', () => {
  // 验收 的第 2 个问题：三维直接用 plan.points 连 A→B，墙在 x=4 时直线穿墙；
  // 第 3/4 个问题：三维没有站点标记，加途经点也没有可见变化。
  const route = { id: 1, name: '过门', points: [[2, 1], [6, 1], [6, 4]] };
  const l = scene([route], [W(4, 0, 4, 6, [door(0.9)])]);
  const plan = planRoutes(l, { getProduct })[0];
  assert.equal(plan.ok, true);
  assert.equal(segmentWalkable(l, [2, 1], [6, 1], { getProduct }), false, '直线 A→B 必须被判穿墙');

  const path = routePathPoints(plan);
  assert.ok(path.length > 2, '真实折线必须比用户锚点多（绕门）');
  for (let i = 0; i + 1 < path.length; i += 1) {
    assert.equal(segmentWalkable(l, path[i], path[i + 1], { getProduct }), true,
      `legs 第 ${i + 1} 段必须可走：${JSON.stringify([path[i], path[i + 1]])}`);
  }
  assert.ok(path.some((p, i) => {
    const q = path[i + 1];
    if (!q || (p[0] - 4) * (q[0] - 4) > 0) return false;
    const t = (4 - p[0]) / (q[0] - p[0]);
    return Math.abs(p[1] + (q[1] - p[1]) * t - 3) < 0.5;
  }), '折线穿过 x=4 时必须在门洞（z≈3）内，不能从墙段穿过去');

  // 2D 与 3D 必须是同一条折线（同一个 plan.legs），否则「3D 路线与 2D 不一致」会复发
  const segs3 = path.slice(1).map((p, i) => [path[i], p]);
  const segs2 = routes2d(l, [plan])[0].segments;
  assert.deepEqual(segs3, segs2, '三维折线必须逐段等于 2D 的 legs 折线');

  const colors = [new THREE.Color(0.2, 0.5, 0.9)];
  const g = buildRouteGeometry([plan], { colors });
  assert.equal(g.markers, 3, '起点 + 1 个途经点 + 终点都要有标记');
  const noMarkers = buildRouteGeometry([plan], { colors, markers: false });
  assert.equal(noMarkers.markers, 0);
  // 端点 2 ×（圆环 20 + 圆点 10）+ 途经点 1 ×（菱形环 8 + 圆点 10）= 78 个三角形
  assert.equal(g.triangles - noMarkers.triangles, 78, '标记必须真的产生三角形，且数量对得上');
  const pos = g.arrows.getAttribute('position');
  const col = g.arrows.getAttribute('color');
  const ink = new THREE.Color(0x24445f);
  let yMarker = 0;
  let inkVerts = 0;
  let colorVerts = 0;
  for (let i = 0; i < pos.count; i += 1) {
    if (Math.abs(pos.getY(i) - 0.026) < 1e-9) {
      yMarker += 1;
      const c = [col.getX(i), col.getY(i), col.getZ(i)];
      if (Math.abs(c[0] - ink.r) < 1e-6 && Math.abs(c[1] - ink.g) < 1e-6 && Math.abs(c[2] - ink.b) < 1e-6) inkVerts += 1;
      if (Math.abs(c[0] - 0.2) < 1e-6 && Math.abs(c[1] - 0.5) < 1e-6 && Math.abs(c[2] - 0.9) < 1e-6) colorVerts += 1;
    }
  }
  assert.equal(yMarker, 78 * 3, '标记必须单独一层（y=0.026），不能和箭头共面');
  assert.ok(inkVerts > 0, '深色环必须有独立颜色');
  assert.ok(colorVerts > 0, '中心必须是路线色');
  assert.match(read('scene3d.js'), /pushDiamond\(p\[0\], p\[1\], 0\.075, 0\.135, markerInk\)/,
    '中间途经点必须是菱形符号（不是和端点一样的圆点）');
  assert.match(read('scene3d.js'), /pushRing\(p\[0\], p\[1\], 0\.075, 0\.125, markerInk\)/,
    '起点/终点必须是圆环');
});

test('颜色：CSS 令牌解析器读字面量；var()/color-mix() 在无浏览器时明确失败（不静默变白）', () => {
  // 浏览器侧由 cdp 探针断言 var(--brand)/color-mix 的真解析；这里钉住 Node 侧契约
  assert.equal(cssColor('#005caf').getHexString(), '005caf');
  assert.equal(cssColor('rgb(26, 158, 106)').getHexString(), '1a9e6a');
  assert.equal(cssColor('var(--brand)'), null, 'Node 里 var() 不许静默变白');
  assert.equal(cssColor('color-mix(in srgb, #005caf 62%, #333)'), null);
  assert.equal(cssColor(''), null);
});

test('预算：6 条 × 20 点的动线三角形仍 < 5000，且都合并在一份几何里', () => {
  // 开放房间（只有四面外墙）里折返走，20 个点 × 6 条 —— 产品上限
  const points = Array.from({ length: 20 }, (_, i) => [1.2 + (i % 10) * 0.55, 1.2 + Math.floor(i / 10) * 2.6]);
  const routes = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: `动线 ${i + 1}`, points }));
  const l = scene(routes);
  const planned = planRoutes(l, { getProduct });
  assert.equal(planned.filter((p) => p.ok).length, 6);
  const g = buildRouteGeometry(planned, { colors: routes.map(() => new THREE.Color(0.2, 0.5, 0.9)) });
  assert.equal(g.valid, 6);
  assert.equal(g.invalid, 0);
  assert.equal(g.markers, 6 * 20, '标记数 = 用户点数（6 条 × 20 点）');
  assert.ok(g.triangles > 0);
  assert.ok(g.triangles < 5000, `routeTriangles 预算 5000，实测 ${g.triangles}`);
});

test('场景装配：墙仍 1 份 mesh；动线 2 份常态 + 高亮最多 1 份；材质真深度测试', () => {
  const src = read('scene3d.js');
  // wallMeshes 的既有判据原样保留（探针里仍然是数墙组的 children）
  assert.match(src, /wallMeshes: wallGroup\?\.children\.length \?\? 0/);
  // 常态恰好两次 addRouteMesh(routeGroup, …)，高亮恰好一次（routeHiGroup）
  assert.equal((src.match(/addRouteMesh\(routeGroup, base\.ribbon/g) || []).length, 1);
  assert.equal((src.match(/addRouteMesh\(routeGroup, base\.arrows/g) || []).length, 1);
  assert.equal((src.match(/addRouteMesh\(routeHiGroup/g) || []).length, 1);
  // 贴地 + 遮挡：depthTest 保留、depthWrite 关闭、polygonOffset 防 z-fighting
  assert.match(src, /depthWrite: false/);
  assert.match(src, /depthTest: true/);
  assert.match(src, /polygonOffset: true/);
  // three 对「透明双面」默认画两遍（2 次 draw call / mesh）—— 动线关掉它，mesh 数才对得上 draw call 数
  assert.match(src, /forceSinglePass: true/);
  // y 分层（地面 0 → 网格 0.002 → 动线 0.008 → 箭头 0.011）
  assert.match(src, /ribbon: 0\.008/);
  assert.match(src, /highlight: 0\.015/);
  assert.match(src, /polygonOffsetUnits: -16/);
  assert.match(src, /arrows: 0\.02/);
  // 高亮只拼选中那一条（不是把全部路线再画一遍）
  assert.match(src, /buildRouteGeometry\(\[lastPlanned\[selIdx\]\]/);
});

test('读数：探针暴露 routeMeshes / routeTriangles / routeCount / routeStatus / routeMarkers', () => {
  const src = read('scene3d.js');
  for (const key of ['routeMeshes', 'routeTriangles', 'routeCount', 'routeStatus', 'routeMarkers']) {
    assert.match(src, new RegExp(`${key}:`), `探针必须暴露 ${key}`);
  }
  assert.match(src, /routeSelectedId/);
  assert.match(src, /if \(!plan \|\| !plan\.ok/, '几何生成必须显式跳过失效路线');
  // 路线数据只读 layout.routes，寻路只调 P1（不自己解析/重新实现 A*）
  assert.match(src, /const routes = Array\.isArray\(l\?\.routes\) \? l\.routes : \[\]/);
  assert.match(src, /planRoutes\(l, \{ getProduct \}\)/);
  assert.ok(!/function findLeg|function smoothPath|MAX_GRID_CELLS/.test(src), '三维不许复制寻路实现');
});

test('第一人称是自由的：走路/碰撞代码里没有动线，动线不拉回、不锁方向', () => {
  const src = read('scene3d.js');
  // 逐个函数取体（到下一个同缩进的 `function` 为止），避免把 setLayout 等无关代码卷进来
  const fnBody = (name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start > 0, `找不到 ${name}`);
    const next = src.indexOf('\n  function ', start + 10);
    return src.slice(start, next > 0 ? next : undefined);
  };
  for (const name of ['walkMove', 'walkDrive', 'walkLook', 'applyWalk', 'doorBoxesFor']) {
    assert.ok(!/route/i.test(fnBody(name)), `${name} 里不许出现动线逻辑（它是视觉层，不参与碰撞/不拉回）`);
  }
  // 几何生成器是纯函数：不碰相机/走路
  const gStart = src.indexOf('export function buildRouteGeometry');
  const gEnd = src.indexOf('function createView3D');
  assert.ok(gStart > 0 && gEnd > gStart);
  assert.ok(!/walkStep|walkDrive|applyWalk|camera\./.test(src.slice(gStart, gEnd)));
  // 站到 A 点复用 wantSpawn，只摆位/朝向，不自动沿线走
  assert.match(src, /function wantSpawn\(x, z, opts = \{\}\)/);
  assert.match(src, /pendingSpawnYaw = Number\.isFinite\(opts\?\.yaw\)/);
  assert.match(src, /function standAtRoute\(id\)/);
  assert.match(src, /wantSpawn\(a\[0\], a\[1\], \{ yaw \}\)/);
});

test('界面：View3D 有可选「站到 A 点」；面客页只读 + 失效信息条', () => {
  const v3d = read('components/View3D.vue');
  assert.match(v3d, /站到 A 点/);
  assert.match(v3d, /view3d\.standAtRoute\(routePick\.value\)/);
  assert.match(v3d, /pickView\('walk'\)/);
  // 不自动沿线走：站到 A 点那段不许调 walkDrive / walkMove
  const fStart = v3d.indexOf('function standAtA()');
  const fEnd = v3d.indexOf('// 读数变化后');
  assert.ok(fStart > 0 && fEnd > fStart);
  const body = v3d.slice(fStart, fEnd);
  assert.ok(!/walkDrive|walkMove|walkStep/.test(body));

  // 实时更新：3D 挂载时 layout 任何深层变化都要重建场景；只允许**一条** deep watch
  const watchCount = (v3d.match(/watch\(\(\) => d\.layout\.value/g) || []).length;
  assert.equal(watchCount, 1, 'layout 监听只应有 1 条 deep watch，不要重复加');
  assert.match(v3d, /watch\(\(\) => d\.layout\.value, scheduleSync, \{ deep: true \}\)/);
  assert.match(v3d, /await view3d\.setLayout\(d\.layout\.value\)/);

  const pv = read('components/PresentView.vue');
  assert.ok(!/from '\.\.\/designer\.js'/.test(pv), '面客页不许 import designer');
  assert.match(pv, /routeNote/);
  assert.match(pv, /pv__note--warn/);
  assert.match(pv, /三维只显示能走通的部分/);
});
