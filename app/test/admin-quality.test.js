import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('产品编辑页把 GET /quality 的 BLOCK/WARN 原样显示，且读取失败不拦编辑', () => {
  const api = read('../src/api.js');
  const page = read('../src/admin/ProductEdit.vue');
  assert.match(api, /adminProductQuality:[\s\S]{0,120}\/quality/);
  assert.match(page, /data-product-quality/);
  assert.match(page, /quality\.gate\.level === 'block'/);
  assert.match(page, /quality\.gate\.issues/);
  assert.match(page, /qualityTrouble/);
  assert.match(page, /产品仍可编辑/);
});

test('质量面板只在有 BLOCK/WARN 时出现，不把 ok 也做成一张黄条', () => {
  const page = read('../src/admin/ProductEdit.vue');
  assert.match(page, /quality\.gate\.level !== 'ok'/);
  assert.match(page, /不能激活/);
  assert.match(page, /不挡编辑\/激活/);
});
