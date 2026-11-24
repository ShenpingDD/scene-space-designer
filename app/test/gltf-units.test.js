import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { fitClone } from '../src/gltf.js';

function box(w, h, d) {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial()));
  return root;
}

function sizeOf(root) {
  root.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(root);
  const s = b.getSize(new THREE.Vector3());
  return [s.x, s.y, s.z];
}

test('fitClone：mm 网格 + mm 声明统一成米（详情相机不能按 1339 m 取景）', () => {
  const root = box(1339, 2073, 833);
  const fit = fitClone(root, { declared: { w: 1339, h: 2073, d: 833 }, envelopeMode: 'fit' });
  const [w, h, d] = sizeOf(root);
  assert.ok(Math.abs(w - 1.339) < 0.002, `w=${w}`);
  assert.ok(Math.abs(h - 2.073) < 0.003, `h=${h}`);
  assert.ok(Math.abs(d - 0.833) < 0.002, `d=${d}`);
  assert.ok(Math.abs(fit.sizeMm.w - 1339) < 2, `sizeMm=${fit.sizeMm.w}`);
});

test('fitClone：m 网格 + mm 声明也只缩放一次，不把 1.339 m 放大成 1339 m', () => {
  const root = box(1.339, 2.073, 0.833);
  const fit = fitClone(root, { declared: { w: 1339, h: 2073, d: 833 }, envelopeMode: 'fit' });
  const [w, h] = sizeOf(root);
  assert.ok(Math.abs(w - 1.339) < 0.002, `w=${w}`);
  assert.ok(Math.abs(h - 2.073) < 0.003, `h=${h}`);
  assert.ok(Math.abs(fit.sizeMm.w - 1339) < 2, `sizeMm=${fit.sizeMm.w}`);
});
