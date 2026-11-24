/**
 * route-format.test.js —— W4 人员地面动线：**方案文件里的形状**（设计决策记录 §四）
 *
 * 这里只钉"格式层"的事，不测寻路（寻路在 `route.test.js`）：
 *   ① 标识换代 + W3 仍是 `walls` 语义（开放场景不许回归）；
 *   ② `state.routes` 白名单：字段顺序 `w,d,h,walls,items,routes?,view?,roomLabels?`；
 *   ③ 同代往返逐字节稳定；空 routes 不发射；
 *   ④ 坏 routes **整份拒绝**且 reason 可读（不静默丢一条）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exportScheme, importScheme, FORMAT, ACCEPTED_FORMATS, W3_FORMAT, W4_FORMAT,
  WALLS_SEMANTICS_FORMATS, roomSemanticsOfFormat,
} from '../src/scheme.js';

const state = (extra = {}) => ({ w: 8, d: 6, h: 3, walls: [], items: [], ...extra });
const doc = (format, s) => JSON.stringify({ format, state: s });

const sampleRoutes = () => [
  { id: 1, name: '主动线', points: [[1.2, 1], [4, 1], [4, 3], [7, 5]] },
  { id: 2, points: [[0, 0], [8, 6]] },
];

test('W4 标识换代：新标识、W3 继续兼容且仍是 walls 语义', () => {
  assert.equal(FORMAT, 'scene-space-designer-scene-routes-columns');
  assert.equal(W4_FORMAT, 'scene-space-designer-scene-routes');
  assert.equal(W3_FORMAT, 'scene-space-designer-scene');
  // 旧标识一个都不能删（用户手里已有这些文件）
  for (const legacy of [
    'scene-space-designer-scene', 'scene-space-designer-windows', 'scene-space-designer-openings',
    'scene-space-designer', 'legacy-spatial-v2', 'legacy-spatial-v3',
    'legacy-spatial-doors-v4',
  ]) {
    assert.ok(ACCEPTED_FORMATS.includes(legacy), legacy + ' 仍须可导入');
  }
  // 房间语义只看这张表：只按"等于 FORMAT 吗"判断会让 W3 方案退回 legacy（院子算回房间）
  assert.deepEqual(WALLS_SEMANTICS_FORMATS, [FORMAT, W4_FORMAT, W3_FORMAT]);
  assert.equal(roomSemanticsOfFormat(FORMAT), 'walls');
  assert.equal(roomSemanticsOfFormat(W3_FORMAT), 'walls', 'W3 方案重开时语义不许退回 legacy');
  assert.equal(roomSemanticsOfFormat('scene-space-designer-windows'), 'legacy');
});

test('W4 往返：routes 进 state，导出→导入→再导出 逐字节一致', () => {
  const layout = { ...state(), routes: sampleRoutes() };
  const a = exportScheme(layout);
  const r = importScheme(a);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.format, FORMAT);
  assert.equal(r.layout.routes.length, 2);
  assert.deepEqual(r.layout.routes[0], sampleRoutes()[0], '站点与名字原样读回');
  assert.deepEqual(r.layout.routes[1], { id: 2, points: [[0, 0], [8, 6]] }, '没名字的动线不许凭空长出一个');
  assert.equal(exportScheme(r.layout), a, '同代往返必须逐字节一致');
});

test('W4 字段顺序：state 里 routes 在 items 之后、view 之前；每条是 id → name? → points', () => {
  const layout = { ...state({ view: { wallOpacity: 'half' } }), routes: sampleRoutes(), roomLabels: {} };
  layout.roomLabels = { abc1234: '库房' };
  const obj = JSON.parse(exportScheme(layout));
  assert.deepEqual(Object.keys(obj.state), ['w', 'd', 'h', 'walls', 'items', 'routes', 'view', 'roomLabels'],
    '顺序也进逐字节比对：' + Object.keys(obj.state));
  const [first, second] = obj.state.routes;
  assert.deepEqual(Object.keys(first), ['id', 'name', 'points']);
  assert.deepEqual(Object.keys(second), ['id', 'points'], '没名字就不写 name 字段');
  assert.deepEqual(first.points[0], [1.2, 1], '点固定是 [x,z] 两项');
});

test('W4 空 routes 不发射；旧 W3 文件打开后 routes=[]', () => {
  const noRoutes = exportScheme(state());
  assert.equal(JSON.parse(noRoutes).state.routes, undefined, '空 routes 不许发射该字段');

  const w3 = importScheme(doc(W3_FORMAT, state()));
  assert.equal(w3.ok, true, w3.message);
  assert.equal(w3.roomSemantics, 'walls', 'W3 → walls（开放场景不回退）');
  assert.deepEqual(w3.layout.routes, [], '旧文件没有这个字段 → 空数组，不是 undefined');
  assert.equal(JSON.parse(exportScheme(w3.layout)).state.routes, undefined, '再导出时也不许冒出来');

  // 显式空数组同理（旧方案的"没有动线"只有一种写法）
  const empty = importScheme(doc(FORMAT, state({ routes: [] })));
  assert.equal(empty.ok, true);
  assert.equal(JSON.parse(exportScheme(empty.layout)).state.routes, undefined);
});

test('W4 坏 routes 整份拒绝：四个原因码各自可辨', () => {
  const bad = (routes) => importScheme(doc(FORMAT, state({ routes })));
  const cases = [
    ['bad-route', [{ id: 1, points: [[0, 0]] }], '只有 1 个点'],
    ['bad-route', [{ id: 1, points: sampleRoutes()[0].points.concat(new Array(18).fill([1, 1])) }], '21 个点'],
    ['bad-route', [{ id: 1, points: [[0, 0], [1]] }], '点不是 [x,z] 两项'],
    ['bad-route', [{ id: 'r1', points: [[0, 0], [1, 1]] }], 'id 不是正整数'],
    ['bad-route', 'not-an-array'],
    ['duplicate-route-id', [{ id: 1, points: [[0, 0], [1, 1]] }, { id: 1, points: [[2, 2], [3, 3]] }]],
    ['too-many-routes', Array.from({ length: 7 }, (_, i) => ({ id: i + 1, points: [[0, 0], [1, 1]] }))],
    ['route-out-of-room', [{ id: 1, points: [[0, 0], [8.5, 0]] }], '点戳出场景右侧'],
    ['route-out-of-room', [{ id: 1, points: [[0, 0], [0, -0.5]] }], '点戳出场景上方'],
  ];
  for (const [reason, routes, why] of cases) {
    const r = bad(routes);
    assert.equal(r.ok, false, `${why || reason} 必须整份拒绝`);
    assert.equal(r.reason, reason, why ? `${why} → ${reason}` : reason);
    assert.ok(typeof r.message === 'string' && r.message.length > 0, '原因要能给人看');
  }
});

test('W4 边界与容差：6 条 / 20 点合法，8.0000001 合法，8.001 拒绝', () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, points: [[0, 0], [1, 1]] }));
  assert.equal(importScheme(doc(FORMAT, state({ routes: six }))).ok, true, '正好 6 条');

  const twenty = { id: 1, points: Array.from({ length: 20 }, (_, i) => [i * 0.1, i * 0.1]) };
  assert.equal(importScheme(doc(FORMAT, state({ routes: [twenty] }))).ok, true, '正好 20 点');

  const edge = importScheme(doc(FORMAT, state({ routes: [{ id: 1, points: [[8.0000001, 6.0000001], [0, 0]] }] })));
  assert.equal(edge.ok, true, '浮点残差 1e-7 不该让方案打不开（与外墙容差同一条纪律）');

  const out = importScheme(doc(FORMAT, state({ routes: [{ id: 1, points: [[8.001, 0], [0, 0]] }] })));
  assert.equal(out.reason, 'route-out-of-room', '容差不是无限宽');
});

test('W4 name 是装饰性字段：非字符串/空串当没写，长名字不截断', () => {
  const long = '一二三四五六七八九十一二三四五六七八九十超出二十字';
  const r = importScheme(doc(FORMAT, state({
    routes: [{ id: 1, name: long, points: [[0, 0], [1, 1]] }, { id: 2, name: 42, points: [[0, 0], [1, 1]] }, { id: 3, name: '', points: [[0, 0], [1, 1]] }],
  })));
  assert.equal(r.ok, true, '一个名字形状不对不该让整份方案打不开');
  assert.equal(r.layout.routes[0].name, long, '长名字不截断（20 字上限归写入端）');
  assert.equal(r.layout.routes[1].name, undefined, '非字符串当没写');
  assert.equal(r.layout.routes[2].name, undefined, '空串当没写');
});
