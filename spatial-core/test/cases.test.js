/**
 * 用例表断言 —— 跑的是 `src/case-runner.js`（与应用、将来的 Java 侧同一份语义）
 *
 * 这个文件被刻意写得很薄：**执行逻辑不在测试里**，否则浏览器里跑的就是另一份实现，
 * "界面与断言同源"这句话就不成立了。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runCases, summarize, RULES } from '../src/case-runner.js';
import * as room from '../src/room.js';
import * as validate from '../src/validate.js';
import * as placement from '../src/placement.js';
import * as scheme from '../src/scheme.js';
import * as doors from '../src/doors.js';
import * as clearance from '../src/clearance.js';
import * as collision from '../src/collision.js';
import * as geometry from '../src/geometry.js';

const here = dirname(fileURLToPath(import.meta.url));
const table = JSON.parse(readFileSync(join(here, 'cases', 'rules.json'), 'utf8'));
const getProduct = (id) => table.catalog[id];

const results = runCases(table, { room, validate, placement, scheme, doors, clearance, collision, geometry, getProduct });

for (const r of results) {
  test(`用例表 ${r.id} — ${r.why}`, () => {
    assert.deepEqual(r.mismatches, [], `${r.id} 不符：${r.mismatches.join(' / ')}`);
  });
}

test('用例表覆盖了全部业务规则', () => {
  const covered = new Set(table.cases.map((c) => c.rule));
  for (const rule of RULES) {
    assert.ok(covered.has(rule), `缺少规则 ${rule} 的用例`);
  }
});

/*
 * ⭐ 产品覆盖契约（与 Java 侧 `CaseRunner.coverage()` 同口径）
 *
 * 这是**用例表与真实目录之间的契约**，不是一条业务用例：目录里每一款都必须至少被一条用例用过。
 * 加了一款产品却没人用过它 → 红；悄悄删掉一款 → 也红。
 * 起因：真目录第 4 款（demo-freezer-upright）长期零覆盖 —— 而它正是「界面能摆、服务端报 bad-item」的那一款。
 *
 * 口径：只认用例的**输入**里出现过的 id（`items[].p` / `item.p` / `product`）——
 * 期望值里写到的 id 不算「用过」（那只是对答案）。
 */
test('用例表覆盖了退路目录里的每一款产品', () => {
  const used = new Set();
  for (const c of table.cases) {
    if (typeof c.product === 'string') used.add(c.product);
    const items = [...(c.items || []), ...(c.item ? [c.item] : [])];
    for (const it of items) if (it && typeof it.p === 'string') used.add(it.p);
  }
  const unused = Object.keys(table.catalog).filter((id) => !used.has(id));
  assert.deepEqual(unused, [], `这些型号没有被任何用例用过：${unused.join('、')}`);
  // 反方向：用例提到了目录里没有的型号 —— 实测有用，因为 `door-clearance` 对
  // **未知型号**和对**上盖（axis=x）**给的是同一种结论（freeDeg=null / level=n/a），
  // 所以某款消失时，用它的那条用例**可能静默通过**。这一条方向把那个洞堵上。
  const unknown = [...used].filter((id) => !(id in table.catalog));
  assert.deepEqual(unknown, [], `用例提到了、目录里却没有的型号：${unknown.join('、')}`);
});

test('用例表整体通过（汇总）', () => {
  const s = summarize(results);
  assert.equal(s.failed, 0, `失败用例：${s.failedIds.join(', ')}`);
  assert.ok(s.total >= 14, `用例偏少：${s.total}`);
});