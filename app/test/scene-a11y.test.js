/**
 * scene-a11y.test.js —— 平面图给读屏的“名字”（B14）
 *
 * 为什么单拎出来测：屏幕上那两个小字是「1200×800」和「#3」——
 * 型号、位置、朝向是**看出来的**。读屏用户拿不到，所以 `item2d` 得给一句完整的。
 * 而这件事最容易悄悄坏掉的方式是：格式改了、字段改名了，读出来的变成 `undefined`，
 * 但**画面上一切正常**（看得见的人不会发现）。所以要断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProduct, loadCatalog } from '../src/catalog.js';
import { item2d } from '../src/scene2d.js';

const SEED = {
  products: [{
    id: 'x1', model: 'X-1', name: '测试箱', w: 1.2, d: 0.8, h: 1.5, color: '#123456',
    sizeNote: '模型测量 · 待核实', notes: { facts: [], features: [] },
    doors: [{ node: 'd', axis: 'y', openAngleDeg: 100 }], recipeDoors: [],
  }],
};

test('B14：每台设备给读屏一个完整的名字（型号 · 编号 · 尺寸 · 位置 · 朝向）', async () => {
  await loadCatalog(async () => SEED);
  assert.ok(getProduct('x1'), '前提：目录装上了');
  const it = item2d({ id: 3, p: 'x1', x: 0.4, z: 1.25, r: 45, doorAmount: 0 });
  assert.equal(it.ariaLabel, 'X-1 #3：1200×800 mm，位置 x 0.40 m、z 1.25 m，朝向 45°');
});

test('B14：读屏名字与可见标注口径一致（同一个数字，不许两套）', async () => {
  await loadCatalog(async () => SEED);
  const it = item2d({ id: 7, p: 'x1', x: 0, z: 0, r: 0, doorAmount: 0 });
  assert.ok(it.ariaLabel.includes(it.label), '屏幕上写「1200×800」，读屏也要听到同一串');
  assert.ok(it.ariaLabel.includes('#7'), '编号必须在里面');
  assert.ok(!it.ariaLabel.includes('undefined'), '缺字段时要落到兜底词，不许读出 undefined');
});

test('B14：型号名缺失时不读出空话（也不崩）', async () => {
  // ⚠️ 这里**不去改目录里的对象**（第一版就是那么写的）：目录是共享单例，
  //    而且适配层返回的是派生对象 —— 改它不生效，测试还以为自己验过了。
  //    老实做一份“没有型号名”的目录。
  await loadCatalog(async () => ({
    products: [{ id: 'nomodel', name: '没有型号的箱', w: 1, d: 1, h: 1, color: '#000', notes: {} }],
  }));
  const it = item2d({ id: 9, p: 'nomodel', x: 0, z: 0, r: 0, doorAmount: 0 });
  assert.ok(it.ariaLabel.startsWith('未知型号 #9'), '宁可说「未知型号」，也不要读出一个空的型号位');
});