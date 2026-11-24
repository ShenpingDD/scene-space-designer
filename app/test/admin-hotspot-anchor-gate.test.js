/**
 * 保存/发布前的热点锚点闸门（2026-11-24 事故回归）
 *
 * 事故形态：维护端把「铭牌」的 nodePath 存成 `#0/#4/DEMO-FZ-040/upper_door/Brand_blue_strokes_2`，
 * 当前模型里根本没有 `#4` 这一段 —— validateDraft 认为它不是结构错误（锚点失效是「可保存的
 * 复核项」），save() 直接 PUT 再 POST /publish，设计端就出现
 * 「锚点节点在当前模型里找不到 …/Brand_blue_strokes_2」。
 *
 * 这里钉住四件事：
 *   ① 有失效锚点 → 不许保存（消息原样是「有 N 条热点锚点无效，未保存」）；
 *   ② 没有失效锚点 → 照常放行；
 *   ③ 把失效项删掉 → 又能保存（失效项必须能被修/被删，不能锁死）；
 *   ④ 模型未就绪时，有热点就整表拦（无法校验就不发布）；0 热点不拦。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  ANCHOR_BLOCK_REASONS, anchorGate, anchorGateText, anchorIssueText, anchorProblem,
} from '../src/admin/hotspot-edit.js';
import { preorder } from '../src/hotspot.js';
import { resolveHotspots, invalidRows, hotspotStatus } from '../src/detail3d.js';

const ROOT = new URL('../src/', import.meta.url);
const readSrc = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');

function makeScene() {
  const root = new THREE.Group();
  root.name = 'DEMO-TEST';
  const cabinet = new THREE.Group();
  cabinet.name = 'Cabinet';
  const door = new THREE.Group();
  door.name = 'upper_door';
  const plate = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  plate.name = 'Brand_blue_strokes_2';
  root.add(cabinet);
  cabinet.add(door);
  door.add(plate);
  return { root, cabinet, door, plate };
}

/** 一条能定位的热点：锚点 = plate，存储坐标 = 锚点局部原点。 */
function validHotspot(over = {}) {
  const { root, plate } = makeScene();
  const hit = preorder(root).find((x) => x.node === plate);
  return {
    root,
    hotspot: {
      id: 7, seq: 1, title: '铭牌',
      nodePath: hit.path.slice(), nodeIndex: hit.index,
      nodeName: 'Brand_blue_strokes_2',
      position: { x: 0, y: 0, z: 0 },
      ...over,
    },
  };
}

assert.equal(ANCHOR_BLOCK_REASONS.includes('model-changed'), false, 'model-changed 是复核提示，不是坏锚点');

test('有失效锚点：闸门拦下，消息与条目都点得出来', () => {
  const { root, hotspot } = validHotspot();
  // 事故里的真实形态：路径里多了一段 `#4`（旧模型根链留下的），当前模型没有。
  const stale = {
    ...hotspot,
    nodePath: ['#0', '#4', 'DEMO-FZ-040', 'upper_door', 'Brand_blue_strokes_2'],
  };
  const gate = anchorGate([stale], root);
  assert.equal(gate.ok, false);
  assert.equal(gate.total, 1);
  assert.equal(gate.blocked.length, 1);
  assert.equal(gate.blocked[0].reason, 'anchor-missing');
  assert.equal(gate.blocked[0].index, 1);
  assert.match(gate.blocked[0].detail, /#0\/#4\/DEMO-FZ-040/);
  assert.equal(anchorGateText(gate.blocked.length), '有 1 条热点锚点无效，未保存');
  const line = anchorIssueText(gate.blocked[0]);
  assert.match(line, /^#01 铭牌：锚点节点在当前模型里找不到/);
  assert.match(line, /#0\/#4\/DEMO-FZ-040/);
});

test('没有失效锚点：闸门放行（正常保存路径不受影响）', () => {
  const { root, hotspot } = validHotspot();
  const gate = anchorGate([hotspot], root);
  assert.deepEqual(gate, { ok: true, total: 1, blocked: [] });
  assert.equal(anchorProblem(hotspot, root), null);
});

test('删掉失效项之后：同一批数据又能保存', () => {
  const { root, hotspot } = validHotspot();
  const stale = { ...hotspot, id: 8, seq: 2, title: '失效项', nodePath: ['#0', '#4', 'gone'] };
  assert.equal(anchorGate([hotspot, stale], root).ok, false);
  // 「删除」就是把它从列表里去掉 —— 剩下的有效项必须放行。
  const after = anchorGate([hotspot], root);
  assert.equal(after.ok, true);
  assert.equal(after.total, 1);
});

test('服务端结论是权威：path 现在能解析，但标了 anchor-missing 仍拦（必须明确重选）', () => {
  const { root, hotspot } = validHotspot({ invalidReason: 'anchor-missing', invalidDetail: '旧模型里找不到' });
  assert.equal(anchorProblem(hotspot, root), null, '几何上其实能定位');
  const gate = anchorGate([hotspot], root);
  assert.equal(gate.ok, false);
  assert.equal(gate.blocked[0].reason, 'anchor-missing');
  assert.equal(gate.blocked[0].detail, '旧模型里找不到');
});

test('model-changed 不拦：锚点还在，只是位置要复核', () => {
  const { root, hotspot } = validHotspot({ invalidReason: 'model-changed' });
  const gate = anchorGate([hotspot], root);
  assert.equal(gate.ok, true);
});

test('同名节点序号超界 / 非等比缩放：分别给出可解释的 reason', () => {
  const { root, hotspot } = validHotspot();
  // 先序序号 9 不存在 → 当前模型里定位不到
  const outOfRange = { ...hotspot, nodeIndex: 9 };
  assert.equal(anchorGate([outOfRange], root).blocked[0].reason, 'anchor-missing');
  // 历史结论 index-out-of-range 直接沿用
  assert.equal(anchorGate([{ ...hotspot, invalidReason: 'index-out-of-range' }], root).blocked[0].reason,
    'index-out-of-range');

  const scaled = validHotspot();
  scaled.root.scale.set(2, 1, 1);
  scaled.root.updateMatrixWorld(true);
  const g = anchorGate([scaled.hotspot], scaled.root);
  assert.equal(g.ok, false);
  assert.equal(g.blocked[0].reason, 'unit-mismatch');
  assert.match(anchorIssueText(g.blocked[0]), /缩放不等比/);
});

test('模型未就绪：有热点整表拦下；0 热点照常保存', () => {
  const { hotspot } = validHotspot();
  const gate = anchorGate([hotspot], null);
  assert.equal(gate.ok, false);
  assert.equal(gate.blocked[0].reason, 'model-not-ready');
  assert.equal(anchorGateText(1), '有 1 条热点锚点无效，未保存');
  // 人工代录/模型还没就绪的产品，保存内容与空看板不能被拦。
  assert.equal(anchorGate([], null).ok, true);
  assert.equal(anchorGate(null, null).ok, true);
});

test('多条失效：一次全列出来，序号按传入顺序（界面上先 sortBySeq）', () => {
  const { root, hotspot } = validHotspot();
  const a = { ...hotspot, id: 11, title: '甲', nodePath: ['#0', '#4', 'a'] };
  const b = { ...hotspot, id: 12, title: '乙', nodePath: ['#0', '#5', 'b'] };
  const gate = anchorGate([hotspot, a, b], root);
  assert.equal(gate.blocked.length, 2);
  assert.deepEqual(gate.blocked.map((x) => x.title), ['甲', '乙']);
  assert.deepEqual(gate.blocked.map((x) => x.index), [2, 3]);
});

// ── 源码级钉子：这道闸门必须真的在 save() 里、而且在 PUT 之前 ────────────────
test('HotspotBoard.save() 在 PUT/publish 之前调用 anchorGate，且被拦时直接 return', () => {
  const src = readSrc('admin/HotspotBoard.vue');
  const saveAt = src.indexOf('async function save()');
  assert.ok(saveAt > 0, '找不到 save()');
  const body = src.slice(saveAt, src.indexOf('async function reloadAfterSave()', saveAt));
  const gateAt = body.indexOf('anchorGate(sortBySeq(hotspots.value), modelRoot)');
  const putAt = body.indexOf('api.adminSaveProductHotspots');
  const pubAt = body.indexOf('api.adminPublishProductContent');
  assert.ok(gateAt > 0, 'save() 里没有 anchorGate');
  assert.ok(putAt > gateAt, '闸门必须在 PUT 之前');
  assert.ok(pubAt > putAt, '发布在保存之后（原有顺序不变）');
  const gateBlock = body.slice(gateAt, putAt);
  assert.match(gateBlock, /if \(!gate\.ok\)/, '闸门不 ok 要有分支');
  assert.match(gateBlock, /saveState\.value = 'failed'/);
  assert.match(gateBlock, /anchorGateText\(gate\.blocked\.length\)/);
  assert.match(gateBlock, /return;/, '被拦必须直接返回，不许继续 PUT');
});

test('编辑器对失效项保留修复入口：重选锚点不被旧锚点锁死', () => {
  const src = readSrc('admin/HotspotBoard.vue');
  const at = src.indexOf('function setAnchorFromSelect');
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf('\nfunction ', at + 10));
  assert.match(body, /repairedFromDead/, '旧锚点找不到时要能重置落点，而不是只报错');
  assert.match(body, /invalidReason = ''/, '修好之后要清掉复核标记');
  // 界面上也不能再写「锚点失效时保存仍允许」这种旧口径
  assert.equal(src.includes('锚点失效时保存仍允许'), false);
});

test('详情页：索引只列能定位的热点，失效项只在「需复核」里出现一次', () => {
  const src = readSrc('components/ProductDetail.vue');
  assert.match(src, /const indexMarkers = computed\(\(\) => markers\.value\.filter\(\(m\) => m\.node\)\)/);
  assert.match(src, /v-for="m in indexMarkers"/, '索引不要再遍历 markers（那会把失效项列成假入口）');
  assert.equal(src.includes('v-for="m in markers"'), false);
  assert.match(src, /:data-detail-index-count="indexMarkers\.length"/);
  assert.match(src, /v-for="\(r, i\) in reviewRows"/, '失效项仍要出现在需复核列表');
  // 坏数据不许把整页打空
  assert.match(src, /const rows = \(detail\.value\?\.hotspots \?\? \[\]\)\.filter\(\(x\) => x && x\.id !== null/);
});

// ── 详情页读端：失效热点只进「需复核」，不影响模型本身 ───────────────────────
test('多个失效锚点：resolveHotspots 只把它们放进 failed，有效项照常解析', () => {
  const { root, hotspot } = validHotspot();
  const bad1 = { ...hotspot, id: 21, title: '旧铭牌', nodePath: ['#0', '#4', 'DEMO-FZ-040', 'upper_door', 'Brand_blue_strokes_2'] };
  const bad2 = { ...hotspot, id: 22, title: '旧开关', nodePath: ['#0', '#4', 'nope'] };
  const { resolved, failed } = resolveHotspots(root, [hotspot, bad1, bad2]);
  assert.equal(resolved.length, 1);
  assert.equal(failed.length, 2);
  assert.deepEqual(failed.map((f) => f.reason), ['anchor-missing', 'anchor-missing']);
  // 服务端已给结论 + 本地解析失败 → 同一个 (id, reason) 不能重复列两次
  const rows = invalidRows({ invalidReasons: [{ hotspotId: 21, reason: 'anchor-missing', title: '旧铭牌' }] }, failed);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.id === 21).length, 1);
  // 全部失效 → 状态是 review，不是 error：模型照常显示，不给整页空白
  assert.equal(hotspotStatus({ counts: { total: 2, valid: 0, invalid: 2 } }, 2), 'review');
});
