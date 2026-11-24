/**
 * analyze-unit.test.js —— docs/07 §10.1 的钉子
 *
 * 断言的是“单位换算发生了一次，而且只发生一次”：
 *   ① 合成 mm GLB → parse/analyze 后 bbox 是 ~1000/2000 mm，不是 ×1000 的百万级；
 *   ② sourceUnit 回报 mm，且 root 已归一化到 m；
 *   ③ 存量 m 模型不误缩放（4 个模型里的 demo-freezer-upright 无贴图，Node 下可分析）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as THREE from 'three';

import { analyzeGlb } from '../src/admin/analyze.js';
import { detectSourceUnit, measure, normalizeToMeters } from '../src/gltf.js';

/** 生成一个最小 GLB：一个三角形，坐标用传入单位。 */
function tinyGlb(vertices) {
  const pos = Buffer.alloc(vertices.length * 4);
  vertices.forEach((v, i) => pos.writeFloatLE(v, i * 4));
  const min = [0, 1, 2].map((axis) => Math.min(...vertices.filter((_, i) => i % 3 === axis)));
  const max = [0, 1, 2].map((axis) => Math.max(...vertices.filter((_, i) => i % 3 === axis)));
  const json = {
    asset: { version: '2.0', generator: 'analyze-unit.test' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'root', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{
      bufferView: 0, componentType: 5126, count: vertices.length / 3, type: 'VEC3', min, max,
    }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length }],
    buffers: [{ byteLength: pos.length }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (pos.length % 4)) % 4;
  const bin = Buffer.concat([pos, Buffer.alloc(binPad, 0)]);
  const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
  const out = Buffer.alloc(total);
  out.write('glTF', 0, 'ascii');
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBuf.length, 12);
  out.writeUInt32LE(0x4E4F534A, 16);
  jsonBuf.copy(out, 20);
  const binHead = 20 + jsonBuf.length;
  out.writeUInt32LE(bin.length, binHead);
  out.writeUInt32LE(0x004E4942, binHead + 4);
  bin.copy(out, binHead + 8);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

test('detect/normalize：mm 文件只归一化一次，m 文件不缩放', () => {
  const mm = new THREE.Mesh(new THREE.BoxGeometry(2000, 1000, 800));
  const info = detectSourceUnit(mm);
  assert.equal(info.sourceUnit, 'mm');
  assert.equal(info.scale, 0.001);

  const out = normalizeToMeters(mm);
  assert.equal(out.sourceUnit, 'mm');
  assert.ok(Math.abs(mm.scale.x - 0.001) < 1e-12);
  const m = measure(mm);
  assert.ok(Math.abs(m.mm.w - 2000) < 0.1, `w=${m.mm.w}`);
  assert.ok(Math.abs(m.mm.h - 1000) < 0.1);

  // 幂等：重复调用不能再乘一次 0.001
  normalizeToMeters(mm);
  assert.ok(Math.abs(mm.scale.x - 0.001) < 1e-12);

  const meters = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 0.8));
  assert.equal(detectSourceUnit(meters).sourceUnit, 'm');
  normalizeToMeters(meters);
  assert.equal(meters.scale.x, 1);
});

test('analyzeGlb：mm GLB 的 bbox 不再 ×1000，并回报 sourceUnit', async () => {
  const buf = tinyGlb([0, 0, 0, 1000, 0, 0, 0, 2000, 0]);
  const a = await analyzeGlb(buf, { fileName: 'mm-fixture.glb' });
  assert.equal(a.sourceUnit, 'mm');
  assert.equal(a.unitScale, 0.001);
  assert.deepEqual(a.mm, { w: 1000, h: 2000, d: 0 });
  assert.equal(a.checks.find((c) => c.key === 'modelUnit').level, 'warn');
  assert.equal(a.picks.size.sourceUnit, 'mm');
  assert.match(a.picks.size.evidence, /×0\.001/);
});

const M_UPRIGHT = '../../assets/models/DEMO-FZ-25U.glb';
const needRaw = (path) => (existsSync(new URL(path, import.meta.url))
  ? {}
  : { skip: `公开仓未发布该原始模型：${path}` });

test('analyzeGlb：存量 m 模型不误报 mm、bbox 不被放大', needRaw(M_UPRIGHT), async () => {
  const b = (await import('node:fs')).readFileSync(new URL('../../assets/models/DEMO-FZ-25U.glb', import.meta.url));
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const a = await analyzeGlb(ab, { fileName: 'demo-freezer-upright.glb' });
  assert.equal(a.sourceUnit, 'm');
  assert.equal(a.unitScale, 1);
  assert.ok(a.mm.w > 600 && a.mm.w < 800, `w=${a.mm.w}`);
  assert.ok(a.mm.h > 900 && a.mm.h < 1100, `h=${a.mm.h}`);
  assert.equal(a.checks.find((c) => c.key === 'modelUnit').level, 'ok');
});
