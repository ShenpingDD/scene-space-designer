/**
 * format.test.js —— 数字格式化的判据。
 *
 * 钉的是"看起来像有东西/进位骗人"这类**不起眼但会让人判断错**的错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, lodCoverage, migrationLabel } from '../src/admin/format.js';

test('0 字节就说 0 B —— 不许显示成 0.0 KB（那是"有一点"的错觉）', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes('0'), '0 B');
});

test('脏数据一律回 0 B，绝不出 NaN', () => {
  for (const v of [null, undefined, '', 'x', NaN, -5, {}]) {
    assert.equal(formatBytes(v), '0 B', JSON.stringify(v) + ' 应回 0 B');
  }
});

test('1023 不许进位成 1.0 KB（进位骗人）', () => {
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
});

test('真实值：库里的模型总占用 710348 B', () => {
  assert.equal(formatBytes(710348), '693.7 KB');
  assert.equal(formatBytes(1048576), '1.00 MB');
});

test('LOD：真缺层不算 ok', () => {
  assert.equal(lodCoverage({ models: 4, withThreeLevels: 4, thin: [] }).ok, true);
  assert.equal(lodCoverage({ models: 4, withThreeLevels: 2, thin: [{}, {}] }).ok, false,
    '真缺层（后端会把 thin 列出来）不算达标');
  assert.equal(lodCoverage({ models: 0, withThreeLevels: 0, thin: [] }).ok, false, '一个模型都没有不算 ok');
});

test('LOD：**按设计少出一级**要算达标（第一版就是在这里报错的）', () => {
  // 实测：demo-ct-scanner 的 lod2 算出来 24270 面，而 lod1 是 24288 面（差 0.07%）→ 优化器故意不重复出。
  // 后端已把这种模型计入 withThreeLevels，并用 byDesign 单独标出来。
  const c = lodCoverage({ models: 4, withThreeLevels: 4, byDesign: 2, declaredLevels: 3, thin: [] });
  assert.equal(c.ok, true, '按设计少出不是缺层 —— 报成缺层就是假角标');
  assert.equal(c.byDesign, 2, '界面要能把"有 2 个是按设计少出"说出来，不能悄悄算过');
  assert.equal(c.thin.length, 0);
});

test('LOD 脏数据不许抛异常', () => {
  for (const v of [null, undefined, {}, 'x', { models: '4' }]) {
    const c = lodCoverage(v);
    assert.equal(typeof c.ok, 'boolean');
    assert.ok(Array.isArray(c.thin));
  }
});

test('迁移版本：有可重复迁移在最后，也不许显示成"没迁移过"', () => {
  assert.equal(migrationLabel({ flywayLastVersioned: '8', migrationRows: 11 }),
    'V8（共 11 条记录，含可重复迁移）');
  assert.ok(migrationLabel({ migrationRows: 11 }).indexOf('未知') === 0);
  assert.ok(migrationLabel(null).indexOf('未知') === 0);
});
