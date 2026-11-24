import test from 'node:test';
import assert from 'node:assert/strict';
import { SHOT_VIEWS, viewPoint, shotIndex } from '../src/views3d.js';
import {
  defaultSelection, buildRequest, missingOf, totalBytes, human, statusLabel, staleAfterEdit,
} from '../src/delivery.js';

/* 交付包这一侧（R6-5 / A10·A11·A13）的纯计算。
   ⚠️ `planSvg.js` **不在这个文件里测**：它依赖 `scene2d` → `@core/*`（Vite 的别名，node 解不了）。
   它的真凭据在真机探针那一步（解压真实交付包、把 平面图.svg 读出来验）—— 那比单测更硬：
   单测只能验字符串，探针验的是**用户手里那个文件**。 */

test('三个固定视角：顺序固定（服务端按这个顺序编号命名）', () => {
  assert.deepEqual(SHOT_VIEWS.map((v) => v.id), ['top', 'front45', 'corner45']);
  assert.deepEqual(SHOT_VIEWS.map((v) => v.label), ['正上方俯视', '正面斜 45°', '斜角 45°']);
  // ⚠️ 这一条与 server 侧 `Delivery.VIEWS` 是**跨语言契约**：两边任一改动，都会在真机探针那一步
  //    （服务端逐位核对视角 id）当场回 400 —— 而不是悄悄把两张图的名字换来换去。
  assert.equal(shotIndex(SHOT_VIEWS[0]), 1);
  assert.equal(shotIndex(SHOT_VIEWS[2]), 3);
});

test('俯视：镜头在房间中心正上方往下看（只差 0.1° 躲开朝上方向的退化）', () => {
  const { pos, target } = viewPoint(12, 9, 2.8, SHOT_VIEWS[0]);
  assert.equal(pos.x, target.x);           // 正中
  // ⚠️ z 上会差一丁点（89.9° 而不是 90°）：那 0.1° 是刻意的 —— 视线与"上方向"完全重合时，
  //    相机自己挑滚转角（不同浏览器可能挑得不一样，同一份数据截出两张不同朝向的图）。
  assert.ok(Math.abs(pos.z - target.z) < 0.05, `z 只该差一点点（那是躲退化用的 0.1°）：Δz=${pos.z - target.z}`);
  assert.ok(pos.y > 2.8 * 3, `要足够高才装得下整间房：y=${pos.y}`);
  assert.equal(target.x, 6);               // 房间中心（12/2）
  assert.equal(target.z, 4.5);
  assert.equal(target.y, 1.4);
});

test('正面斜 45°：站在中轴正前方、半空中，俯角正好 45°', () => {
  const { pos, target } = viewPoint(12, 9, 2.8, SHOT_VIEWS[1]);
  assert.equal(pos.x, target.x, '在中轴上（左右不偏）');
  assert.ok(pos.z > 9, '在房间的 +z 那一侧（"正面"）');
  assert.ok(pos.y > target.y, '半空中（在视线上方）');
  // 45° 的定义：水平位移与垂直升高相等
  assert.ok(Math.abs((pos.z - target.z) - (pos.y - target.y)) < 1e-9,
    `俯角要是 45°：Δz=${pos.z - target.z} Δy=${pos.y - target.y}`);
});

test('斜角 45°：从 +x/+z 角上、半空中看对角，水平两轴位移相等', () => {
  const { pos, target } = viewPoint(12, 9, 2.8, SHOT_VIEWS[2]);
  assert.ok(pos.x > 12, '在 +x 一侧');
  assert.ok(pos.z > 9, '在 +z 一侧');
  assert.ok(Math.abs((pos.x - target.x) - (pos.z - target.z)) < 1e-9,
    '方位角 45°：两个水平方向的位移要相等');
  // 俯仰角 45° 的正确说法是：**升高 = 水平距离**（不是"升高 = 某一个轴的位移"）
  const horiz = Math.hypot(pos.x - target.x, pos.z - target.z);
  assert.ok(Math.abs((pos.y - target.y) - horiz) < 1e-9,
    `俯仰角 45°：升高要等于水平距离（Δy=${pos.y - target.y} 水平=${horiz}）`);
});

test('三个视角互相分得开（不是同一个机位换名字）', () => {
  const pts = SHOT_VIEWS.map((v) => JSON.stringify(viewPoint(8, 6, 2.8, v).pos));
  assert.equal(new Set(pts).size, 3, '三个机位必须真的不一样');
});

test('勾选：默认全勾（含必带的两件）', () => {
  const items = [{ id: 'json' }, { id: 'plan' }, { id: 'readme' }];
  assert.deepEqual(defaultSelection(items), ['json', 'plan', 'readme']);
  assert.deepEqual(defaultSelection(null), []);
});

test('拼请求：没有版本号要拦住；三张图不齐要拦住（并说清要几张）', () => {
  assert.throws(() => buildRequest({ rev: null, shots: ['a', 'b', 'c'] }), /还没有版本号/);
  assert.throws(() => buildRequest({ rev: 3, shots: ['a', 'b'] }), /正好 3 张/);
  const body = buildRequest({ rev: '3', items: ['json'], withAssets: true, note: 'x', planSvg: '<svg/>', shots: ['a', 'b', 'c'] });
  assert.equal(body.expectRev, 3, '版本号要转成数字（后端是 Integer）');
  assert.equal(body.withAssets, true);
  assert.deepEqual(body.shots, ['a', 'b', 'c']);
});

test('「勾了但包里没有」要能算出来（少一件的包与齐的包长得一样）', () => {
  const items = [
    { id: 'cover', label: '封面（方案库列表同款）', files: ['封面.png'] },
    { id: 'shots', label: '三维截图 3 张（固定视角）', files: ['三维截图-1-俯视.png', '三维截图-2-正面斜45.png', '三维截图-3-斜角45.png'] },
    { id: 'json', label: '方案数据（可再导回）', files: ['方案.json'] },
  ];
  const files = [{ name: '方案.json', bytes: 10 }, { name: '三维截图-1-俯视.png', bytes: 20 }];
  const missing = missingOf(['cover', 'shots', 'json'], items, files);
  assert.equal(missing.length, 2, `应当报两件：${missing.join(' / ')}`);
  assert.ok(missing[0].includes('封面.png'), missing[0]);
  assert.ok(missing[1].includes('三维截图-2-正面斜45.png') && missing[1].includes('三维截图-3-斜角45.png'),
    '三张里少两张要说清是哪两张：' + missing[1]);
  assert.deepEqual(missingOf(['json'], items, files), [], '齐的那件不许报');
});

test('合计大小与人读的单位', () => {
  assert.equal(totalBytes([{ bytes: 10 }, { bytes: 32 }, {}]), 42);
  assert.equal(totalBytes(null), 0);
  assert.equal(human(512), '512 B');
  assert.equal(human(2048), '2.0 KB');
  assert.equal(human(3 * 1024 * 1024), '3.0 MB');
});

test('交付状态的中文复用维护端那一份（同一个状态不许有两个词）', () => {
  // 一开始这里写过 draft→「未交付」，而维护端早就写着 draft→「草稿」—— 那就是同一个概念两个词
  assert.equal(statusLabel('draft'), '草稿');
  assert.equal(statusLabel('delivered'), '已交付');
  assert.ok(statusLabel('weird').includes('weird'), '认不得的码原样显示（不猜近义词）');
});

test('已交付之后又动内容：提醒重新交付（不是禁止）', () => {
  assert.ok(staleAfterEdit('delivered').includes('重新打一版交付包'));
  assert.equal(staleAfterEdit('draft'), '');
});