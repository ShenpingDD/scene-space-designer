/**
 * 规则 5 断言集：方案导出 / 导入 / 往返一致（FIX-05 与 FIX-21 的验收）
 * 基准：R1 浏览器实测 —— 导出 907 B、导入后再导出，MD5 完全相同。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayout, applyRoomSize } from '../src/room.js';
import { addItem, rotateItem } from '../src/placement.js';
import { exportScheme, importScheme, checkFileSize, legacyConvertReport, ACCEPTED_FORMATS, LIMITS } from '../src/scheme.js';
import { roomsOf } from '../src/rooms.js';
import { mkWallSeg, wallSeg } from '../src/wall.js';
/** 墙对象工厂（W1 起墙是对象；测试里写坐标更直观） */
const W = (x, z, xx, zz) => mkWallSeg(x, z, xx, zz);
const seg = (w) => wallSeg(w);

const CATALOG = new Map([
  ['demo-cabinet-800', { id: 'demo-cabinet-800', w: 1.15192501, d: 1.09483496, h: 1.98669948 }],
  ['demo-freezer-dual', { id: 'demo-freezer-dual', w: 0.99, d: 0.8712, h: 1.98 }],
]);
const get = (id) => CATALOG.get(id);

/** 复刻 R1 实测的布局：12×9 → 3 台设备（含 1 台转 90°）+ 2 面内墙 → 改 14×11 */
function sampleLayout() {
  let layout = createLayout({ w: 12, d: 9 });
  layout = addItem(layout, 'demo-cabinet-800', { getProduct: get }).layout;
  layout = addItem(layout, 'demo-freezer-dual', { getProduct: get }).layout;
  layout = addItem(layout, 'demo-freezer-dual', { getProduct: get }).layout;
  layout = rotateItem(layout, layout.items[2].id, 90);
  layout.walls.push(W(2, 2, 2, 7), W(6, 2, 6, 7));
  return applyRoomSize(layout, { w: 14, d: 11, h: 2.8 }).layout;
}

test('FIX-05：导出→导入→再导出 逐字节一致（R1 实测 MD5 相同）', () => {
  const a = exportScheme(sampleLayout());
  const r = importScheme(a);
  assert.equal(r.ok, true);
  const b = exportScheme(r.layout);
  assert.equal(b, a);
});

test('导出格式与原型一致：format + state，缩进 2', () => {
  const text = exportScheme(sampleLayout());
  const obj = JSON.parse(text);
  assert.equal(obj.format, 'scene-space-designer-scene-routes-columns');
  assert.deepEqual(Object.keys(obj).sort(), ['format', 'state']);
  assert.match(text, /\n  "format"/);
});

test('往返保留内墙与旋转角度', () => {
  const r = importScheme(exportScheme(sampleLayout()));
  assert.equal(r.layout.walls.length, 6);
  assert.deepEqual(r.layout.walls[4], W(2, 2, 2, 7));
  assert.equal(r.layout.items[2].r, 90);
  assert.equal(r.nextId, 4);
});

test('FIX-21：四类失败给出各自的原因（原型共用一句话）', () => {
  assert.equal(importScheme('{not json').reason, 'not-json');
  assert.equal(importScheme({ format: 'other', state: {} }).reason, 'bad-format');
  assert.equal(importScheme({ format: ACCEPTED_FORMATS[2], state: { w: 99, d: 6, h: 2.8, walls: [], items: [] } }).reason, 'bad-room');
  assert.equal(importScheme({ format: ACCEPTED_FORMATS[2], state: { w: 8, d: 6, h: 2.8, walls: [], items: new Array(101).fill({ id: 1, p: 'demo-cabinet-800', x: 1, z: 1, r: 0 }) } }).reason, 'too-many-items');
  assert.equal(importScheme({ format: ACCEPTED_FORMATS[2], state: { w: 8, d: 6, h: 2.8, walls: [], items: [{ id: 1, p: 'nope', x: 1, z: 1, r: 0 }] } }, { getProduct: get }).reason, 'bad-item');
  // 不给目录时内核只做结构校验（服务端可独立使用）
  assert.equal(importScheme({ format: ACCEPTED_FORMATS[2], state: { w: 8, d: 6, h: 2.8, walls: [], items: [{ id: 1, p: 'nope', x: 1, z: 1, r: 0 }] } }).ok, true);
  assert.equal(importScheme({ format: ACCEPTED_FORMATS[2], state: { w: 8, d: 6, h: 2.8, walls: [], items: [{ id: 1, p: 'demo-cabinet-800', x: 1, z: 1, r: 0 }, { id: 1, p: 'demo-cabinet-800', x: 4, z: 1, r: 0 }] } }).reason, 'duplicate-id');
  // 斜墙【合法】（本次改动）：0.05 m 的墙才是坏的
  assert.equal(importScheme({ format: ACCEPTED_FORMATS[2], state: { w: 8, d: 6, h: 2.8, walls: [[0, 0, 0.05, 0]], items: [] } }).reason, 'bad-wall');
  assert.equal(importScheme({ format: ACCEPTED_FORMATS[2], state: { w: 8, d: 6, h: 2.8, walls: [[1, 1, 5, 4]], items: [] } }).ok, true, '斜墙必须能被导入');
  assert.equal(importScheme({ format: ACCEPTED_FORMATS[2], state: { w: 8, d: 6, h: 2.8, walls: [[0, 0, 0.05, 0]], items: [] } }).reason, 'bad-wall');
});

test('必须继续兼容历史格式 v2 / v3', () => {
  for (const f of ACCEPTED_FORMATS.slice(0, 2)) {
    const r = importScheme({ format: f, state: { w: 8, d: 6, h: 2.8, walls: [[0, 0, 8, 0]], items: [] } });
    assert.equal(r.ok, true, `${f} 应可导入`);
  }
});

test('写入端产出的方案一定可被读取端接受（FIX-05 的核心不变量）', () => {
  for (const size of [{ w: 3, d: 3 }, { w: 20, d: 20 }, { w: 8, d: 6 }]) {
    const r = importScheme(exportScheme(createLayout(size)));
    assert.equal(r.ok, true, `${size.w}×${size.d} 的方案应可回导`);
  }
});

test('文件大小预检', () => {
  assert.equal(checkFileSize(LIMITS.fileBytes).ok, true);
  assert.equal(checkFileSize(LIMITS.fileBytes + 1).reason, 'too-large');
});

test('格式标识：新写用新标识，历史标识一律仍可导入', async () => {
  const s = await import('../src/scheme.js');
  assert.equal(s.FORMAT, 'scene-space-designer-scene-routes-columns');
  // ⚠️ 历史标识**一个都不能删**：`scene-space-designer` 是 W1 之前那一代（墙是扁平数组），
  // 用户手里已有这种文件。新标识按 docs/31:65 的规矩**不带版本后缀**。
  for (const legacy of ['scene-space-designer-scene', 'scene-space-designer-windows', 'scene-space-designer-openings', 'scene-space-designer', 'legacy-spatial-v2', 'legacy-spatial-v3', 'legacy-spatial-doors-v4']) {
    assert.ok(s.ACCEPTED_FORMATS.includes(legacy), legacy + ' 仍须可导入');
    assert.ok(s.importScheme({ format: legacy, state: { w: 8, d: 6, h: 2.8, walls: [], items: [] } }).ok);
  }
  // 新标识自然也能导入；陌生标识一律拒绝
  assert.ok(s.ACCEPTED_FORMATS.includes(s.FORMAT));
  assert.equal(s.importScheme({ format: 'other', state: {} }).ok, false);
});


// ────────────────────── W3 旧方案转换预检（P4 的 SchemePanel 用） ──────────────────────

/** 少画一面外墙的旧方案：legacy 语义下外框会替它补上缺口（1 间），walls 语义下就是开放场景（0 间） */
function missingOneWall() {
  const layout = { w: 8, d: 6, h: 2.8, walls: [W(0, 0, 8, 0), W(8, 0, 8, 6), W(8, 6, 0, 6)], items: [] };
  const legacyRoom = roomsOf({ ...layout, roomSemantics: 'legacy' })[0];
  return { layout: { ...layout, roomLabels: { [legacyRoom.id]: '库房' } }, legacyRoom };
}

test('W3 转换预检：缺一面外墙的旧方案是有损的（房间 1 → 0，房名要掉，开放面积如实）', () => {
  const { layout } = missingOneWall();
  const r = legacyConvertReport(layout);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.lossy, true, '房间数变少 + 房名掉 → 保存前必须让用户看见');
  assert.equal(r.roomsBefore, 1, 'legacy 语义下外框兜底，是 1 间房 —— 旧方案原来的样子');
  assert.equal(r.roomsAfter, 0, 'walls 语义下缺一面墙就不构成房间');
  assert.equal(r.labelsKept, 0);
  assert.equal(r.droppedLabels, 1);
  assert.deepEqual(r.droppedLabelNames, ['库房'], '掉的名字要能直接说出来，不能让界面自己再算');
  assert.equal(r.openAreaM2, 48, '开放面积 = 场景面积 − 房间面积 = 48 × 0');
});

test('W3 转换预检：四面外墙齐全的旧方案**不丢东西**（无损，房间名留得住）', () => {
  const layout = createLayout({ w: 8, d: 6 });
  const legacyId = roomsOf({ ...layout, roomSemantics: 'legacy' })[0].id;
  const withName = { ...layout, roomLabels: { [legacyId]: '库房' } };
  const r = legacyConvertReport(withName);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.lossy, false, '房间数没变、名字没掉 → 不阻断保存');
  assert.equal(r.roomsBefore, 1);
  assert.equal(r.roomsAfter, 1);
  assert.equal(r.labelsKept, 1);
  assert.equal(r.droppedLabels, 0);
  assert.equal(r.openAreaM2, 0, '四面围合的房间没有开放面积');
});

test('W3 转换预检是**纯函数**：不改输入、读数不进 state', () => {
  const { layout } = missingOneWall();
  const before = JSON.stringify(layout);
  legacyConvertReport(layout);
  assert.equal(JSON.stringify(layout), before, '预检不是转换：输入一个字都不许动');
  const text = exportScheme(layout);
  assert.ok(!text.includes('roomSemantics'), '派生口径不进方案文件：' + text);
  assert.ok(!text.includes('openArea'), '开放面积是派生量，不进方案文件');
});
