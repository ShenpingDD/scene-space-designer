/**
 * dynamic-assets.test.js —— DB 动态产品（352/379/demo-*）在 3D 主场景的资产回退。
 *
 * 钉住三件事：
 *   ① 静态 manifest 有 entry 时**绝不**走 DB 回退（静态优先）；
 *   ② 没有静态 entry、但 `/api/catalog` 给了 assetFile 时，生成单级 entry，不报“没有可用模型”；
 *   ③ 既无静态 entry 又无 assetFile 才返回 null（missingAssetItems 只该加在这种情况）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { dynamicEntryOf, resolveAssetPlan } from '../src/gltf.js';

const demoBlender = {
  id: 'demo-blender-001',
  name: '演示医疗推车',
  model: 'DEMO-BLENDER-001',
  w: 0.676, h: 1.1, d: 0.672,
  assetFile: 'assets/optimized/demo-blender-001.lod0.glb',
  envelopeMode: 'fit',
  doors: [],
};
const demoRobot = {
  id: 'demo-robot-arm',
  name: '演示六轴机械臂',
  model: 'DEMO-ROBOT-ARM-001',
  w: 1.17, h: 1.76, d: 0.9,
  assetFile: 'assets/optimized/demo-robot-arm.lod0.glb',
  envelopeMode: 'fit',
  doors: [],
};

test('动态资产：静态 entry 存在时优先静态，哪怕 product 也有 assetFile', () => {
  const staticEntry = {
    id: 'demo-ct-scanner', modelCode: 'DEMO-CT-100', lods: [{ level: 'lod0', file: 'assets/optimized/demo-ct-scanner.lod0.glb' }],
  };
  const plan = resolveAssetPlan('demo-ct-scanner', { count: 4, product: demoBlender, staticEntry });
  assert.equal(plan.dynamic, false);
  assert.equal(plan.entry, staticEntry);
  assert.equal(plan.level, 'lod0');
  // 显式指定级别仍只在静态 entry 的可用级别里选
  const forced = resolveAssetPlan('demo-ct-scanner', { count: 4, force: 'lod1', product: demoBlender, staticEntry });
  assert.equal(forced.dynamic, false);
  assert.equal(forced.level, 'lod0', '静态没有 lod1 时按 chooseLevel 的最近档回退，不落到动态 entry');
});

test('动态资产：无静态 entry 时两类 demo 都能回退 assetFile，级别为 single', () => {
  for (const product of [demoBlender, demoRobot]) {
    const plan = resolveAssetPlan(product.id, { count: 2, product, staticEntry: null });
    assert.ok(plan, `${product.id} 必须能选到文件`);
    assert.equal(plan.dynamic, true);
    assert.equal(plan.level, 'single');
    assert.equal(plan.entry.assetFile, product.assetFile);
    assert.equal(plan.entry.lods[0].file, product.assetFile);
    assert.equal(plan.entry.declared.w, product.w);
    assert.deepEqual(plan.entry.doors, [], '目录没给门就不伪造');
  }
});

test('动态资产：无静态 entry 且没有 assetFile 才是真的“没有可用模型”', () => {
  assert.equal(resolveAssetPlan('demo-no-file', { product: { id: 'demo-no-file' }, staticEntry: null }), null);
  assert.equal(resolveAssetPlan('demo-no-product', { product: null, staticEntry: null }), null);
  assert.equal(dynamicEntryOf({ id: 'x' }), null);
});

test('动态资产：bboxMm 兜底尺寸按 mm→m，不把毫米当米', () => {
  const e = dynamicEntryOf({
    id: 'demo-storage-cabinet', model: 'DEMO-SC-100', assetFile: 'assets/optimized/demo-storage-cabinet.lod0.glb',
    bboxMm: { w: 595, h: 1990, d: 800 },
  });
  assert.deepEqual(e.declared, { w: 0.595, h: 1.99, d: 0.8 });
});

test('scene3d 的 syncItems 走 plan + loadAssetFile，且 missing 只在 plan 为 null 时累加', () => {
  const src = readFileSync(new URL('../src/scene3d.js', import.meta.url), 'utf8');
  assert.match(src, /resolveAssetPlan\(item\.p/);
  assert.match(src, /loadAssetFile\(assetFile, plan\.entry\)/);
  assert.match(src, /if \(!plan\)[\s\S]{0,160}missingAssetItems\+\+/);
  assert.doesNotMatch(src, /if \(!want\)[^\n]*missingAssetItems\+\+/, '旧的 pickLevel 缺失分支必须被 plan 替换');
});
