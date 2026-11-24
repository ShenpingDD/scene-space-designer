/**
 * circulation-2d.test.js —— P2 动线在 2D 侧的可执行判据（task-45）
 *
 * 只测能脱离浏览器验的部分：
 *   ① scene2d.routes2d 是**纯派生**：路径来自 P1 planRoute，不把折线/长度/状态写回 layout；
 *   ② 预览与落笔共用同一条 points / 同一个 planRoute（用户看到的线就是提交后的线）；
 *   ③ 失效路线保留用户点、只画红虚线诊断段，不画穿墙假路；
 *   ④ 添加/撤销/重做/改名/删除一条路线 = 一步；6 色令牌与 6 条上限；
 *   ⑤ 2D/P2 的 DOM 钩子与右栏 Teleport 接线存在（Vue 组件本身由真机探针验）。
 *
 * 不伪造 DOM：Vue 没有测试渲染器；第 ⑤ 层只钉住“接线没被改回旧分支”，
 * 真机交互由 QA 的 P4 探针负责（docs/93 §11）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ROUTE_ARROW_D, scene2d, routes2d } from '../src/scene2d.js';
import { designer as d } from '../src/designer.js';
import { planRoute } from '@core/route.js';
import { createLayout } from '@core/room.js';
import { mkWallSeg } from '@core/wall.js';
import { getProduct } from '../src/catalog.js';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const layoutWith = (routes, over = {}) => ({ ...createLayout({ w: 8, d: 6, h: 2.8 }), routes, ...over });
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('P2：routes2d 只派生 —— 路径/长度/状态/颜色都不写回 layout', () => {
  const layout = layoutWith([{ id: 1, points: [[1, 1], [7, 5]] }]);
  const before = JSON.stringify(layout);
  const s = scene2d(layout);
  const r = s.routes[0];

  assert.equal(r.id, 1);
  assert.equal(r.number, 1);
  assert.equal(r.colorIndex, 1);
  assert.equal(r.status, 'ok');
  assert.equal(r.name, '动线 1');
  assert.deepEqual(r.stops.map((p) => p.label), ['A', 'B']);
  assert.ok(r.d.startsWith('M'), '合法路线必须有可画的自动折线');
  assert.ok(r.length > 0, '长度来自 P1 planRoute');
  assert.ok(r.arrows.length > 0, '合法路线要有方向箭头');
  assert.equal(JSON.stringify(layout), before, 'scene2d 不得改 layout');
  assert.deepEqual(Object.keys(layout.routes[0]).sort(), ['id', 'points'], 'state 里只允许 id/name/points');
});

test('P2：箭头形状尖头朝 +x，angle 沿 A→B 方向 —— 不能把尖端画在尾部', () => {
  // 验收 实际看到 A→B 被画成 B→A：旋转角一直是对的，错的是路径本身。
  // 不只钉字符串：解析路径顶点，证明**尖端是局部 +x 极点**，其余顶点都在它后面。
  const pts = [...ROUTE_ARROW_D.matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
  assert.ok(pts.length >= 4, `箭头路径格式变了，必须重新核对朝向：${ROUTE_ARROW_D}`);
  const [tip, ...rest] = pts;
  assert.ok(tip.x > 0, `尖端必须在 +x（tip=${tip.x}）`);
  assert.equal(tip.y, 0, '尖端必须落在局部 x 轴上');
  assert.ok(rest.every((p) => p.x < tip.x), '所有尾部顶点都必须在尖端后面（不能画成 B→A）');
  assert.ok(rest.some((p) => p.x < 0), '尾部至少有一个负 x 顶点');

  const r = routes2d(layoutWith([{ id: 1, points: [[1, 3], [6, 3]] }]))[0];
  assert.equal(r.arrows[0]?.angle, 0, 'A→B 沿 +x 时 angle 必须是 0（不是 180）');
  const rev = routes2d(layoutWith([{ id: 2, points: [[6, 3], [1, 3]] }]))[0];
  assert.equal(rev.arrows[0]?.angle, 180, 'B→A 时 angle 必须翻到 180，证明方向跟着 points 走');

  // 防回归：模板必须引用同一个常量，不能又在模板里内联一份旧形状。
  const view = read('app/src/components/PlanView.vue');
  assert.match(view, /:d="ROUTE_ARROW_D"/, 'PlanView 箭头必须绑定 ROUTE_ARROW_D');
  assert.doesNotMatch(view, /M-0\.10 0 L0\.08 -0\.055/, '模板里不能再出现旧的反向箭头');
});

test('P2：预览与提交共用同一条 planRoute —— 线型路径逐字符一致', () => {
  const points = [[1.1, 1.0], [6.9, 4.8]];
  const layout = layoutWith([{ id: 9, points }]);
  const preview = planRoute(layout, { id: 9, points }, { getProduct });
  assert.equal(preview.ok, true);

  const previewD = routes2d(layout, [preview])[0]?.d;
  const committedD = scene2d(layout).routes[0].d;
  assert.ok(previewD);
  assert.equal(previewD, committedD, '预览与落笔不能是两套几何');
  assert.deepEqual(preview.points, points, 'P1 不应静默挪用户点');
});

test('P2：墙挡住后路线保留 points，状态 blocked、红虚线诊断段、无箭头、有原因', () => {
  const base = layoutWith([{ id: 1, points: [[1, 1], [7, 5]] }]);
  const blocked = {
    ...base,
    walls: [...base.walls, mkWallSeg(4, 0.2, 4, 5.8)],
  };
  const r = routes2d(blocked)[0];
  assert.equal(r.status, 'blocked');
  assert.ok(r.reason, '失效必须有原因码');
  assert.deepEqual(r.points.map((p) => [p.x, p.z]), [[1, 1], [7, 5]], '站点不因失效被改动');
  assert.equal(r.arrows.length, 0, '失效路线不画方向箭头（避免假装能走）');
  assert.match(r.d, /^M1\.0000 1\.0000 L7\.0000 5\.0000$/, '只画用户点之间的诊断段');
});

test('P2：6 条路线的颜色槽按创建顺序循环 1..6，线型随槽位（多路线不只靠颜色）', () => {
  const routes = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, points: [[0.8, 0.8 + i * 0.7], [7.2, 1.2 + i * 0.7]] }));
  const s = scene2d(layoutWith(routes));
  assert.deepEqual(s.routes.map((r) => r.colorIndex), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(s.routes.map((r) => r.number), [1, 2, 3, 4, 5, 6]);
  const css = read('app/src/style.css');
  for (const i of [1, 2, 3, 4, 5, 6]) {
    assert.match(css, new RegExp(`--route-${i}\\s*:`), `缺少 --route-${i}`);
  }
  assert.match(css, /route-pattern-2/, '线型 2 必须有独立规则（颜色不是唯一通道）');
  // P3 用 getComputedStyle 读 --route-N 喂 Three.Color；color-mix 在 Chrome 里只返回 token 串，
  // 解析不了，所以 4–6 必须是已预混的具体色值（1–3 的 var() 会由浏览器解析成 hex）。
  for (const i of [4, 5, 6]) {
    assert.match(css, new RegExp(`--route-${i}:\\s*#[0-9a-f]{6}`), `--route-${i} 要能直接被 3D 解析`);
  }
});

test('P2：designer 加一条 = 一个撤销步；撤销/重做后派生结果跟着回来', () => {
  d.resetNewDesign();
  const before = d.layout.value.routes?.length ?? 0;
  const r = d.addRoute([[1, 1], [6, 4]]);
  assert.ok(r?.id > 0);
  assert.equal(d.routeRows.value.length, before + 1);
  assert.equal(d.canUndo.value, true);

  d.undo();
  assert.equal(d.layout.value.routes?.length ?? 0, before, '一次撤销应把整条路线拿掉');
  d.redo();
  assert.equal(d.layout.value.routes?.length ?? 0, before + 1);
  assert.equal(d.routeRows.value[0].status, 'ok');
});

test('P2：非法/场外点拒绝写入；一条路线最多 20 点；最多 6 条', () => {
  d.resetNewDesign();
  assert.equal(d.addRoute([[1, 1], [40, 40]]), null, '场外点不能创建路线');
  assert.equal(d.addRoute([[1, 1]]), null, '少于 2 点不能创建路线');

  const ok = d.addRoute([[1, 1], [2, 2]]);
  assert.ok(ok);
  const many = Array.from({ length: 19 }, (_, i) => [1 + i * 0.2, 1 + (i % 2) * 0.5]);
  const added = d.addRoutePoint(ok.id, many.at(-1));
  assert.equal(added, true, '19 个点再加一个仍应在 20 点以内时成功');

  // 重置后灌 6 条合法短路线，第 7 条必须被上限挡住
  d.resetNewDesign();
  for (let i = 0; i < 6; i += 1) {
    const r = d.addRoute([[0.8, 0.6 + i * 0.8], [2.0, 0.9 + i * 0.8]]);
    assert.ok(r, `第 ${i + 1} 条应能加`);
  }
  assert.equal(d.layout.value.routes.length, 6);
  assert.equal(d.addRoute([[4, 4], [5, 4]]), null, '第 7 条必须被 6 条上限拒绝');
});

test('P2：改名（≤20 字）、删点保底 2 点、删整条可撤销、显隐不进 state', () => {
  d.resetNewDesign();
  const r = d.addRoute([[1, 1], [3, 1], [5, 2]]);
  assert.ok(r);
  assert.equal(d.renameRoute(r.id, '参观路线'), true);
  assert.equal(d.layout.value.routes[0].name, '参观路线');
  assert.equal(d.renameRoute(r.id, '一'.repeat(21)), false, '超过 20 字必须拒绝');
  assert.equal(d.layout.value.routes[0].name, '参观路线', '拒绝超长时不能截断/写坏');

  assert.equal(d.removeRoutePoint(r.id, 1), true);
  assert.equal(d.layout.value.routes[0].points.length, 2);
  assert.equal(d.removeRoutePoint(r.id, 0), false, '少于 2 点时不许删');

  d.toggleRouteVisible(r.id);
  assert.equal(d.routeRows.value[0].visible, false);
  assert.deepEqual(Object.keys(d.layout.value.routes[0]).sort(), ['id', 'name', 'points'], '显隐不进 state');

  d.removeRoute(r.id);
  assert.equal(d.layout.value.routes.length, 0);
  d.undo();
  assert.equal(d.layout.value.routes.length, 1);
});

test('P2：DOM 钩子 / 右栏 Teleport / 180° 网站点坐标全部接线', () => {
  const plan = read('app/src/components/PlanView.vue');
  assert.match(plan, /data-tool="route"/);
  assert.match(plan, /data-route-id/);
  assert.match(plan, /data-route-status/);
  assert.match(plan, /data-route-point/);
  assert.match(plan, /data-route-handle/);
  assert.match(plan, /data-route-hit/);
  assert.match(plan, /data-flow-legend/);
  assert.match(plan, /data-route-card/);
  assert.match(plan, /to="#rail-right"/, '动线卡必须 Teleport 到右栏（不改 Inspector 写作用域）');
  assert.match(plan, /@click="toggleRoute"/);
  assert.match(plan, /route-swatch/);
  assert.match(plan, /route-pattern-/, '线型必须进模板');
});

test('P2：window pointerup / autoPan / mode 互斥 / 键盘 L 的兜底都在', () => {
  const plan = read('app/src/components/PlanView.vue');
  assert.match(plan, /window\.addEventListener\('pointerup', onWindowPointerUp\)/);
  assert.match(plan, /function onWindowPointerUp/);
  assert.match(plan, /routePress\.value/);
  assert.match(plan, /trackAutoPan\(evt\.clientX, evt\.clientY\)/);
  assert.match(plan, /d\.setRouteMode\(false\)/, '进入其它模式必须退动线');
  assert.match(plan, /evt\.key === 'l' \|\| evt\.key === 'L'/, 'L 快捷键');
  assert.match(plan, /is-route/);
});
