import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  flatValues, formRows, rangeText, groupRows, isDirty, dirtyRows,
  draftPatch, draftProblems, publishDoneText, problemLines,
} from '../src/admin/params.js';

/* 这里是「参数配置页要回答的判断」的钉子。

   ⚠️ 规格用的是**真文件**（`server/src/main/resources/params-schema.json`，由
   `npm run params` 从内核 `PARAM_SPEC` 生成）。手编一份小夹具看着更干净，
   但它证明不了最要紧的那件事：**表单是否真的盖住了全部 64 项**（条数由 `admin-batch4-cleanup.test.js` 与 `check-facts` 守） ——
   少显示一项的后果是"有一项再也改不了，而界面看着是完整的"。
   当前值就用规格里的 `defaults`（形状与接口的 `values` 一致：分组嵌套）。 */

const SCHEMA = JSON.parse(readFileSync(new URL('../../server/src/main/resources/params-schema.json', import.meta.url), 'utf8'));
const VALUES = SCHEMA.defaults;          // 接口发的是同一形状（分组嵌套）
const ROWS = formRows(SCHEMA, VALUES);
const byPath = (p) => ROWS.find((r) => r.path === p);

test('表单盖住全部项：64 行 / 12 栏 / 其中 7 项不允许在后台改', () => {
  // W1 门洞：+7 条 opening.* +1 条 walk.eyeM，新增一组「门洞」→ 43 行 / 9 栏；
  // M1a 多房间：+2 条 room.nameMaxChars / room.minAreaM2 → 45 行；
  // 第 3 轮审查 C-10：+1 条 model.envelopeTolMm（1:1 对账容差收成一处）→ 46 行
  // W2 窗：+8 条 window.* 并新增一组「窗」→ 54 行 / 10 栏
  // W4 动线：+6 条 route.* 并新增一组「动线」→ 60 行 / 11 栏
  // W5 结构柱：+4 条 column.* 并新增一组「结构柱」→ 64 行 / 12 栏
  assert.equal(ROWS.length, 64);
  const groups = groupRows(SCHEMA, ROWS);
  assert.equal(groups.length, 12);
  // 四档之和必须 = 总数：分栏漏项/重项都会在这里露出来
  assert.equal(groups.reduce((n, g) => n + g.rows.length, 0), 64);
  assert.deepEqual(groups.map((g) => g.id), ['room', 'space', 'layout', 'column', 'scheme', 'door', 'opening', 'window', 'walk', 'route', 'model', 'history']);
  assert.equal(ROWS.filter((r) => !r.editable).length, 7);
});

test('不能改的行必须把原因写出来（灰框 + 一句原话，不许只有灰框）', () => {
  for (const r of ROWS.filter((x) => !x.editable)) {
    assert.equal(r.lockedNote.startsWith('不允许在后台改：'), true, r.path);
    assert.ok(r.lockedNote.length > '不允许在后台改：'.length + 4, '要带上规格里那句 help：' + r.path);
  }
  // 允许改的行不该有这句
  assert.equal(byPath('door.openOkDeg').lockedNote, '');
  assert.equal(byPath('door.openOkDeg').editable, true);
});

test('范围的说法照规格拼，界面不写死数字', () => {
  assert.equal(rangeText(byPath('door.openOkDeg')), '0~180 ° 步长 1');
  assert.equal(rangeText(byPath('walk.wallClearanceM')), '0~0.3 m 步长 0.01');
});

test('"改了吗"按数值比：输入框来的字符串 90 与当前值 90 不算改过', () => {
  const r = byPath('door.openOkDeg');
  assert.equal(r.now, 90);
  assert.equal(isDirty(r, { 'door.openOkDeg': '90' }), false, '★ 字符串与数字不能判成"改过"');
  assert.equal(isDirty(r, { 'door.openOkDeg': 90 }), false);
  assert.equal(isDirty(r, { 'door.openOkDeg': '85' }), true);
  assert.equal(isDirty(r, {}), false, '没进草稿就是没动过');
  assert.equal(dirtyRows(ROWS, { 'door.openOkDeg': '90' }).length, 0);
});

test('"动没动过"按**读值**判（不能用 hasOwnProperty 查键 —— Vue 代理不追踪它）', () => {
  const r = byPath('door.openOkDeg');
  // 这一条是 B4b 探针挖出来的真 bug：真实页面里 drafts 是 Vue 的响应式代理，
  // 而 Vue 3 的代理没实现 getOwnPropertyDescriptor 陷阱 → hasOwnProperty 不被追踪 →
  // "改了 N 项"与发布按钮永远不更新（对真人=这一页完全不可用），
  // 而普通对象上一切正常（所以当年的单测全绿）。
  assert.equal(isDirty(r, { 'door.openOkDeg': undefined }), false, 'undefined = 没进草稿表');
  assert.equal(isDirty(r, {}), false);
  assert.equal(isDirty(r, { 'door.openOkDeg': '90' }), false);
  assert.equal(isDirty(r, { 'door.openOkDeg': '85' }), true);
  // 键在不在，只认"值是不是 undefined"——这一条就是上面那个 bug 的钉子
  const proxyish = new Proxy({ 'door.openOkDeg': '85' }, {});
  assert.equal(isDirty(r, proxyish), true, '换成代理对象也一样要判得出来');
});

test('补丁只含改过的项（整份提交会把别人刚改的值盖回去）', () => {
  const { patch, changed } = draftPatch(ROWS, { 'door.openOkDeg': '85', 'room.maxW': '25' });
  assert.deepEqual(changed, ['room.maxW', 'door.openOkDeg']);     // 顺序照表单
  assert.deepEqual(patch, { room: { maxW: 25 }, door: { openOkDeg: 85 } });
  assert.equal('layout' in patch, false, '★ 没动过的分组不许出现在补丁里');
});

test('不允许改的项一个都不进补丁（界面禁了不算保证，但也不该发出去白撞一次 400）', () => {
  const { patch, changed } = draftPatch(ROWS, { 'door.sweepStepDeg': '5' });
  assert.deepEqual(changed, []);
  assert.deepEqual(patch, {});
});

test('发布前自检：非数字 / 超范围 / 想改不让改的，各说各的话', () => {
  const a = draftProblems(ROWS, { 'door.openOkDeg': 'abc' });
  assert.equal(a.length, 1);
  assert.match(a[0].message, /必须是数字/);
  assert.match(a[0].message, /abc/);

  const b = draftProblems(ROWS, { 'door.openOkDeg': '200' });
  assert.match(b[0].message, /大于上限 180/);

  const c = draftProblems(ROWS, { 'room.minW': '0.5' });
  assert.match(c[0].message, /小于下限 1/);

  // ⚠️ 记住这一条，别再写错测试：规格里每项的 min/max 是**字段自己的范围**
  //   （`room.minW` 是 1~100），而「长宽只能 3~20」是**跨字段的硬范围**，归内核/后端判。
  //   所以自检不该拦 `room.minW = 1`（它在字段范围内），拦不拦得住是后端的事。
  assert.deepEqual(draftProblems(ROWS, { 'room.minW': '1' }), [], '字段范围内的值不该被自检拦下');

  const d = draftProblems(ROWS, { 'walk.spawnStepM': '1' });
  assert.match(d[0].message, /不允许在后台改/);

  assert.deepEqual(draftProblems(ROWS, { 'door.openOkDeg': '85' }), [], '合法的要过');
});

test('回执要把"改了几项 + 新版本 + 前台会跟上"说全，不许只说发布成功', () => {
  const t = publishDoneText({ changed: ['door.openOkDeg', 'room.maxW'], rev: 49717190 });
  assert.match(t, /已发布 2 项/);
  assert.match(t, /door\.openOkDeg/);
  assert.match(t, /49717190/);
  assert.match(t, /自动跟上/);
  assert.match(publishDoneText({ changed: [], message: '没有任何改动（一项都没写）' }), /没有任何改动/);
});

test('失败时逐条读出来：后端给的话原样显示，不换成"参数不合法"四个字', () => {
  const lines = problemLines({ errors: [{ path: 'door.openOkDeg', message: 'door.openOkDeg（绿灯阈值）超出范围：200 不在 0~180° 之间' }] });
  assert.equal(lines.length, 1);
  assert.match(lines[0].message, /超出范围：200 不在 0~180° 之间/, '★ 后端那句话要一字不动地显示给人看');
  assert.equal(problemLines({ reason: 'bad-params' })[0].message, 'bad-params', '没带 errors 也要有话说');
});

test('分组嵌套摊平成 path（规格给的是 path，接口给的是嵌套）', () => {
  const flat = flatValues({ room: { maxW: 25 }, door: { openOkDeg: 85 } });
  assert.deepEqual(flat, { 'room.maxW': 25, 'door.openOkDeg': 85 });
  assert.deepEqual(flatValues(null), {});
  assert.deepEqual(flatValues({ room: 1, door: { x: 2 } }), { 'door.x': 2 }, '坏形状不许炸，跳过就行');
});