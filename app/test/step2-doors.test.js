/**
 * step2-doors.test.js —— 步骤 2：真实铰链 pivot / 扁平 extras / 无可动零件
 *
 * 钉住的是**数值事实**，不是"有这个函数"：
 *   ① 352（demo-storage-cabinet）的 `door` 节点 extras 被识别为 single，pivotMm 原样带出；
 *   ② 绕 [287.71,70,363] 转 +105° 后，门自由边落在柜体前方（z 远大于前脸），
 *      反向转会穿到柜后 —— 证明 openDirection="+" 的符号没搞反；
 *   ③ 379（demo-storage-cabinet）单节点、无任何可动件 extras → 门表为空，不许伪造；
 *   ④ 维护端门表输出带 pivotMm/openDirection，旧形状（无 pivot）保持不变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';

import { analyzeGlb } from '../src/admin/analyze.js';
import { doorOptionsOf, hingeNodesJson } from '../src/admin/wizard.js';
import { doorsFromScene, isHingedDoorPart } from '../src/detail3d.js';
import { applyDoor, bindDoors, fitClone, parseGlbBuffer } from '../src/gltf.js';

// 真实 GLB 带 WebP 贴图；node 下给一个惰性解码桩（只影响贴图，不影响几何）
globalThis.self = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

function glb(path) {
  const b = readFileSync(new URL(path, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

const M352 = '../../assets/optimized/demo-storage-cabinet.lod0.glb';
const M379 = '../../assets/optimized/demo-storage-cabinet.lod0.glb';
const MDEMO = '../../assets/optimized/demo-blender-001.lod0.glb';
const PIVOT = [287.71, 70, 363];

// 公开仓只随仓库发布 **1 个**演示模型（`demo-ct-scanner.lod0.glb`）。其余演示模型不在版本库里，
// 依赖它们的用例在文件缺失时**显式跳过**（SKIP ≠ PASS：报告里会写明跳过了几条、为什么）。
const needModel = (path) => (existsSync(new URL(path, import.meta.url))
  ? {}
  : { skip: `公开仓未发布该演示模型：${path}` });


test('352：扁平 extras 的 door 节点被识别为 single，pivotMm 原样带出', needModel(M352), async () => {
  const a = await analyzeGlb(glb(M352), { fileName: 'demo-storage-cabinet.lod0.glb' });
  assert.equal(a.doors.found.length, 1, '不许再静默当成"没有门"');
  const d = a.doors.found[0];
  assert.equal(d.node, 'door');
  assert.equal(d.part, 'single', 'partType=door_single → part=single');
  assert.equal(d.specCompliant, false, '名字不在约定名单里就是 false（事实，不粉饰）');
  assert.equal(d.expectAxis, 'y');
  assert.equal(d.axisMatches, true);
  assert.equal(d.angleDeg, 105);
  assert.deepEqual(d.pivotMm, PIVOT);
  assert.equal(d.openDirection, '+');
  assert.equal(d.side, '+z', '方位用门网格 bbox 中心判，不用门节点原点');

  const opts = doorOptionsOf(a);
  assert.equal(opts.length, 1);
  assert.deepEqual(opts[0].pivotMm, PIVOT);
  assert.equal(opts[0].openDirection, '+');
  assert.equal(opts[0].axis, 'y');
  assert.equal(opts[0].openAngleDeg, 105);

  assert.deepEqual(JSON.parse(hingeNodesJson(a)), [{
    node: 'door', axis: 'y', openAngleDeg: 105, pivotMm: PIVOT, openDirection: '+',
  }]);
});

test('352：绕真实铰链转 105° 门自由边朝外；反向转会穿到柜后', needModel(M352), async () => {
  const root = await parseGlbBuffer(glb(M352));
  const doors = doorsFromScene(root);
  assert.equal(doors.length, 1);
  assert.deepEqual(doors[0].pivotMm, PIVOT);

  fitClone(root, { declared: { w: 595, h: 1990, d: 800 }, envelopeMode: '1:1' });
  const bound = bindDoors(root, { doors });
  assert.equal(bound.length, 1);
  assert.ok(bound[0].pivot, '必须建 pivot Group —— 直接转门会绕门中心转');
  assert.equal(bound[0].pivotOk, true, 'pivot 世界点应与 extras 的 hingePoint 对齐（≤2mm）');
  // 这组断言专门钉住 pivotMm 的单位：pivotMm 是 root local 的毫米，
  // 若误当成米再 /1000，pivotDeltaMm 会变成 -287.7/-70/-363（差 1000 倍），这里立刻红。
  assert.ok(bound[0].pivotDeltaMm, '必须回报 pivot 与 hingePoint 的三轴偏差');
  for (const axis of ['x', 'y', 'z']) {
    const delta = bound[0].pivotDeltaMm[axis];
    assert.ok(Math.abs(delta) <= 2, `pivot ${axis} 轴偏差 ${delta}mm 应 ≤2mm`);
    assert.ok(Math.abs(bound[0].hingeWorldMm[axis] - PIVOT[['x', 'y', 'z'].indexOf(axis)]) <= 2,
      `pivot ${axis}=${bound[0].hingeWorldMm[axis]}mm`);
  }

  const boxMm = () => {
    root.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(bound[0].obj);
    return { min: b.min.clone().multiplyScalar(1000), max: b.max.clone().multiplyScalar(1000) };
  };

  applyDoor(bound[0], 0);
  const closed = boxMm();
  assert.ok(Math.abs(closed.max.z - 400) < 3, `关门时门前脸 z=${closed.max.z}（应为约 400）`);
  assert.ok(closed.max.x < 300, `关门时门在柜体宽度内 x=${closed.max.x}`);

  applyDoor(bound[0], 1);
  const open = boxMm();
  // 门左前角 (-292.1, 381) 绕 (287.71,363) 转 +105° → x≈455、z≈918（柜体前脸 z≈400 之外）
  assert.ok(open.max.z > 900, `开门后自由边应在柜前 z≈900+，实测 max.z=${open.max.z}`);
  assert.ok(open.max.x > 450, `开门后自由边应向右前摆出，实测 max.x=${open.max.x}`);
  assert.ok(open.min.z > 300, `不许穿到柜后（反向转会到 z<0），实测 min.z=${open.min.z}`);
  assert.ok(open.min.z >= closed.min.z - 3,
    `开门时门后沿不得比关门状态更深（不穿柜体），关门 min.z=${closed.min.z} 开门 min.z=${open.min.z}`);

  // 反向：把符号翻成 -1，门会转到柜体后方 —— 证明 +105 不是随便选的
  bound[0].openAngleRad *= -1;
  applyDoor(bound[0], 1);
  const wrong = boxMm();
  assert.ok(wrong.min.z < 0, `反向开门的自由边应钻到柜后 z<0，实测 min.z=${wrong.min.z}`);
});

test('379：单节点 1200E 没有可动件 extras → 门表为空（页面必须明说，不许伪造）', needModel(M379), async () => {
  const root = await parseGlbBuffer(glb(M379));
  assert.equal(doorsFromScene(root).length, 0);
  const a = await analyzeGlb(glb(M379), { fileName: 'demo-storage-cabinet.lod0.glb' });
  assert.equal(a.doors.found.length, 0, '没有门就是 0，不靠名字猜');
  assert.equal(a.picks.door.doorPart, null, '门型也不能凭空自动填');
});

test('openDirection 只乘一次："-" 绕 +y 转负；hingeAxis 为 -y 时 "+" 也要翻成负', () => {
  const root = new THREE.Group();
  const door = new THREE.Group();
  door.name = 'door';
  door.userData = {
    partType: 'door_single', hingeAxis: [0, 1, 0], hingePoint: [0, 0, 0],
    openAngleDeg: 90, openDirection: '-',
  };
  root.add(door);
  const doors = doorsFromScene(root);
  assert.equal(doors.length, 1);
  assert.equal(doors[0].openDirection, '-');
  assert.ok(doors[0].openAngleRad > 0, '表里只存正的开角，方向单独存');
  const bound = bindDoors(root, { doors });
  applyDoor(bound[0], 1);
  assert.ok(Math.abs(bound[0].obj.rotation.y + Math.PI / 2) < 1e-9, `rotation=${bound[0].obj.rotation.y}`);

  const root2 = new THREE.Group();
  const door2 = new THREE.Group();
  door2.name = 'door';
  door2.userData = {
    partType: 'door_single', hingeAxis: [0, -1, 0], hingePoint: [0, 0, 0],
    openAngleDeg: 90, openDirection: '+',
  };
  root2.add(door2);
  const d2 = doorsFromScene(root2);
  assert.equal(d2[0].openDirection, '-', '绕 -y 的正向 = 绕 +y 的负向');
  const b2 = bindDoors(root2, { doors: d2 });
  applyDoor(b2[0], 1);
  assert.ok(Math.abs(b2[0].obj.rotation.y + Math.PI / 2) < 1e-9);
});

test('详情页：没有可动件时不显示开门按钮，并明说"该模型无可动零件"', () => {
  const src = readFileSync(new URL('../src/components/ProductDetail.vue', import.meta.url), 'utf8');
  assert.match(src, /data-detail-nonmovable/);
  assert.match(src, /该模型无可动零件/);
  assert.match(src, /hasMovableParts/);
  const tools = src.slice(src.indexOf('class="pd__tools"'), src.indexOf('data-detail-markers'));
  assert.match(tools, /v-if="hasMovableParts"/, '门控件必须由实际绑到的门门控');
  const gate = src.slice(src.indexOf('v-if="hasMovableParts"'), src.indexOf('data-detail-nonmovable'));
  assert.match(gate, /data-door-toggle/, '开门按钮只能出现在有可动件的分支里');
});


test('464：米制网格 + 毫米 hingePoint 不能把门甩飞；抽屉不得绕中心转', needModel(MDEMO), async () => {
  const root = await parseGlbBuffer(glb(MDEMO));
  // 这个 Blender 件的网格是米、extras 的 hingePoint 仍是毫米；根没有 0.001 缩放。
  assert.equal(root.userData.modelUnit.sourceUnit, 'm');
  const all = doorsFromScene(root);
  assert.deepEqual(all.map((d) => d.node), ['door_single', 'drawer_01', 'drawer_02', 'drawer_03']);
  assert.deepEqual(all.filter(isHingedDoorPart).map((d) => d.node), ['door_single']);

  fitClone(root, { declared: { w: 676, h: 1310.5, d: 672 }, envelopeMode: '1:1' });
  const bound = bindDoors(root, { doors: all.filter(isHingedDoorPart) });
  assert.equal(bound.length, 1, '抽屉不是铰链门，不能混进开门绑定');
  assert.equal(bound[0].pivotOk, true, 'pivot 必须落在 [-260,190.5,285]mm；按米直传会差 1000 倍');
  for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(bound[0].pivotDeltaMm[axis]) <= 2);

  const door = root.getObjectByName('door_single');
  const box = () => new THREE.Box3().setFromObject(door);
  const closed = box();
  applyDoor(bound[0], 1);
  root.updateMatrixWorld(true);
  const open = box();
  assert.ok(Math.abs(closed.max.z * 1000 - 336) < 2, `关门 max.z=${closed.max.z * 1000} 应≈336mm`);
  assert.ok(open.max.z * 1000 > 700, `开门自由边 z=${open.max.z * 1000}mm 应朝柜前伸出去`);
  assert.ok(open.min.z * 1000 > 0, `开门 min.z=${open.min.z * 1000}mm 不应穿到柜后/消失`);
  for (const name of ['drawer_01', 'drawer_02', 'drawer_03']) {
    assert.ok(!bound.some((b) => b.node === name), `${name} 不能被 bindDoors 当成铰链门`);
  }
});

test('旧门表（无 pivotMm/openDirection）输出形状不变，pivotOk=null', () => {
  const analysis = { doors: { found: [{ node: 'outer_door', expectAxis: 'y', angleDeg: 106 }] } };
  assert.deepEqual(JSON.parse(hingeNodesJson(analysis)), [
    { node: 'outer_door', axis: 'y', openAngleDeg: 106 },
  ]);
  const root = new THREE.Group();
  const door = new THREE.Group();
  door.name = 'outer_door';
  root.add(door);
  const bound = bindDoors(root, { doors: [{ node: 'outer_door', axis: 'y', openAngleRad: 1.85 }] });
  assert.equal(bound[0].pivot, null);
  assert.equal(bound[0].pivotOk, null, '没有 pivot 的旧门不许冒充已校准');
  applyDoor(bound[0], 1);
  assert.ok(Math.abs(door.rotation.y - 1.85) < 1e-9, '旧行为必须保持：绕节点原点转');
});
