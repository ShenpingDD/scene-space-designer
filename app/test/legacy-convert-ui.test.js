/**
 * legacy-convert-ui.test.js —— P4「旧方案转为开放场景」的**可执行判据**
 *
 * 分两层，和 `open-scene-ui.test.js` 同一个做法：
 *   ① 纯函数：`legacyGate` 的放行/阻断决策（含 2026-10-22 那个死循环的回归用例）；
 *   ② 真判据对账：拿内核 `scheme.legacyConvertReport` 的真实报告喂给 gate，
 *      确认"少一间房"这件事真的会被挡住、话术里真有那间房的名字；
 *   ③ 源码挂点：Vue 组件没有渲染测试器（app 依赖里没有 @vue/test-utils），
 *      只钉住"接线在、且同意没被写成常驻放行"；真机行为由 QA 的 P4 探针负责。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LEGACY_GATE, legacyGate } from '../src/legacyGate.js';
import { createLayout } from '@core/room.js';
import { roomsOf } from '@core/rooms.js';
import { legacyConvertReport } from '@core/scheme.js';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const panel = read('app/src/components/SchemePanel.vue');
const sizeCard = read('app/src/components/RoomSizeCard.vue');

/** 有损报告：两间房转完只剩一间，另有个房名挂不上 */
const lossyReport = () => ({
  ok: true,
  error: null,
  lossy: true,
  roomsBefore: 2,
  roomsAfter: 1,
  labelsKept: 0,
  droppedLabels: 1,
  droppedLabelNames: ['主卧'],
  openAreaM2: 12,
});

/* ---------------- ① 决策：放行 / 阻断 ---------------- */

test('legacyGate：⭐ 点过「转为开放场景」之后必须放行（死循环回归）', () => {
  // 曾经的 bug：preflight 只判 semantics，于是 convertLegacy 置了同意也照样读到 lossy → 永远存不进去
  const g = legacyGate({ semantics: 'legacy', consent: true, read: lossyReport });
  assert.equal(g.action, LEGACY_GATE.PROCEED, '同意过就必须放行，否则「保存」按钮点了也没用');
  assert.equal(g.consumeConsent, true, '同意只生效一次：调用方读完后要立刻清掉');
});

test('legacyGate：同意被用掉之后，同一份有损方案会**再次**被挡住', () => {
  // 保存失败 / 又改了墙之后不该留下"以后都放行"
  const again = legacyGate({ semantics: 'legacy', consent: false, read: lossyReport });
  assert.equal(again.action, LEGACY_GATE.BLOCK);
  assert.equal(again.reason, 'legacy-lossy');
});

test('legacyGate：有损必须阻断，话术里要说出少几间、以及哪个房名先挂起', () => {
  const g = legacyGate({ semantics: 'legacy', consent: false, read: lossyReport });
  assert.equal(g.reason, 'legacy-lossy');
  assert.equal(g.report.fewer, 1, '2 → 1 间，少 1 间');
  assert.match(g.message, /少/);
  assert.match(g.message, /主卧/, '哪个名字挂起要写在话术里，不能只说"会少"');
  assert.match(g.message, /挂起/);
});

test('legacyGate：无损放行，且**不**记同意（用户没做过选择，下次预检照常问）', () => {
  const g = legacyGate({
    semantics: 'legacy',
    consent: false,
    read: () => ({ ...lossyReport(), lossy: false, roomsBefore: 1, roomsAfter: 1, droppedLabels: 0, droppedLabelNames: [] }),
  });
  assert.equal(g.action, LEGACY_GATE.PROCEED);
  assert.equal(g.consumeConsent, false);
});

test('legacyGate：新方案（walls）不问、也不调内核报告', () => {
  let calls = 0;
  const g = legacyGate({ semantics: 'walls', consent: false, read: () => { calls += 1; return lossyReport(); } });
  assert.equal(g.action, LEGACY_GATE.PROCEED);
  assert.equal(calls, 0, '新方案没有"转换"这回事，别白跑一遍几何');
});

/* ---------------- ② fail-closed：拿不到报告一律挡住 ---------------- */

test('legacyGate：内核预检没接线 → 挡住并说明（不许放行）', () => {
  const g = legacyGate({ semantics: 'legacy', consent: false, read: () => null });
  assert.equal(g.action, LEGACY_GATE.BLOCK);
  assert.equal(g.reason, 'legacy-no-preflight');
  assert.match(g.message, /没有接入/);
});

test('legacyGate：内核预检抛错 → 挡住（原话带上，不吞异常）', () => {
  const g = legacyGate({ semantics: 'legacy', consent: false, read: () => { throw new Error('面遍历没有收敛'); } });
  assert.equal(g.action, LEGACY_GATE.BLOCK);
  assert.equal(g.reason, 'legacy-bad-layout');
  assert.match(g.message, /面遍历没有收敛/);
});

test('legacyGate：报告自己说 ok:false → 挡住', () => {
  const g = legacyGate({ semantics: 'legacy', consent: false, read: () => ({ ok: false, error: 'layout 缺少 walls' }) });
  assert.equal(g.action, LEGACY_GATE.BLOCK);
  assert.equal(g.reason, 'legacy-bad-layout');
  assert.match(g.message, /layout 缺少 walls/);
});

/* ---------------- ③ 真判据对账：缺一面外墙的旧方案 ---------------- */

test('内核报告 → gate：缺一面外墙的旧方案会被挡，且房名「主卧」出现在话术里', () => {
  const l0 = createLayout({ w: 8, d: 6, h: 2.8 });
  // 旧方案：少一面外墙（外框兜出来的那间房，转成开放场景就没了）
  let legacy = { ...l0, walls: l0.walls.slice(0, -1).map((w) => ({ ...w })), roomSemantics: 'legacy' };
  const name = roomsOf(legacy)[0].id;
  legacy = { ...legacy, roomLabels: { [name]: '主卧' } };

  const g = legacyGate({ semantics: 'legacy', consent: false, read: () => legacyConvertReport(legacy) });
  assert.equal(g.action, LEGACY_GATE.BLOCK);
  assert.equal(g.reason, 'legacy-lossy');
  assert.equal(g.report.roomsBefore, 1);
  assert.equal(g.report.roomsAfter, 0);
  assert.match(g.message, /主卧/);

  // 用户点了「转为开放场景」：同一条路上必须真的能存下去
  const go = legacyGate({ semantics: 'legacy', consent: true, read: () => legacyConvertReport(legacy) });
  assert.equal(go.action, LEGACY_GATE.PROCEED);
});

/* ---------------- ④ 源码挂点（不伪造 DOM） ---------------- */

test('SchemePanel：同意是一次性的（只有 convertLegacy 置 true），四个钩子都在', () => {
  assert.match(panel, /consent: legacyConfirmed\.value/, 'preflight 要把同意交给 gate');
  assert.match(panel, /if \(gate\.consumeConsent\) legacyConfirmed\.value = false;/, '同意读完即清');
  const sets = panel.match(/legacyConfirmed\.value = true;/g) ?? [];
  assert.equal(sets.length, 1, '「置同意」只该有 convertLegacy 一处 —— 预检自己置 true 就是老 bug 的根源');
  assert.match(panel, /data-legacy-block/);
  assert.match(panel, /data-convert-legacy/);
});

test('RoomSizeCard：「走哪条路」与被拦下的原因都在界面上有挂点', () => {
  assert.match(sizeCard, /:data-size-mode="mode"/);
  assert.match(sizeCard, /data-size-blocked/);
  assert.match(sizeCard, /d\.message\.value/, '被拦下的原因要用内核原话，界面不重算序号');
});
