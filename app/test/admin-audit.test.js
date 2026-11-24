import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  byText, changeText, condParts, emptyText, filterLine, isFiltered, keyLabel, noteText,
  pageText, schemaIndex, snapshotRows, timeText, unitOf, valueText,
} from '../src/admin/audit.js';

/* 这里是「参数审计页要回答的判断」的钉子。

   ⚠️ 规格用**真文件**（与 `admin-params.test.js` 同一份，由 `npm run params` 从内核生成）：
   手编小夹具看着更干净，但它证明不了"项的名字真的认得出来"。
   而这一页最要紧的三件事都是**容易被安静地做错**的那种：
     ① 「显示 N / 共 M 条」——少了 M 就是静默筛选；
     ② 没写原因 / 认不出的人 / 没有快照 —— **缺数据不补**；
     ③ 空态要说清是"真的没有"还是"被条件筛没了"。 */

const SCHEMA = JSON.parse(readFileSync(new URL('../../server/src/main/resources/params-schema.json', import.meta.url), 'utf8'));
const INDEX = schemaIndex(SCHEMA);

const ROW = {
  id: 21, key: 'door.openOkDeg', rev: 351788645,
  oldValue: 90, newValue: 85, changedBy: '1', changedByName: '本机用户',
  changedAt: '2026-09-29T21:58:14', note: '',
};

test('项的名字认得出来；认不出就原样给路径，**不编名字**', () => {
  assert.match(keyLabel('door.openOkDeg', INDEX), /（door\.openOkDeg）$/);
  assert.ok(keyLabel('door.openOkDeg', INDEX).length > 'door.openOkDeg'.length, '应当带上中文名');
  assert.equal(unitOf('door.openOkDeg', INDEX), '°');
  // 库里可能留着早已从规格里删掉的项 —— 那时只有一个路径可给
  assert.equal(keyLabel('gone.oldKey', INDEX), 'gone.oldKey');
  assert.equal(unitOf('gone.oldKey', INDEX), '');
});

test('谁改的：有名字给名字+id；**没名字就给原始 id**；两样都没有才说没记', () => {
  assert.equal(byText(ROW), '本机用户（#1）');
  assert.equal(byText({ changedBy: '7' }), '#7', '没查到时显示原始 id —— 不许留白、不许编');
  assert.equal(byText({}), '（没记是谁）');
});

test('前后值：带单位；原来是"没有这一项"时说清是新增', () => {
  assert.equal(changeText(ROW, '°'), '90° → 85°');
  assert.equal(changeText({ oldValue: null, newValue: 85 }, '°'), '新增：85°');
  assert.equal(valueText(null), '（原来没有这一项）', 'null 与"值是 0"是两件事');
  assert.equal(valueText(0), '0');
});

test('原因：**没写就写「（没写原因）」**（A19 取消"必须写"之后，这是常态，但不许留白）', () => {
  assert.equal(noteText(ROW), '（没写原因）');
  assert.equal(noteText({ note: '   ' }), '（没写原因）');
  assert.equal(noteText({ note: '改小一点' }), '改小一点');
});

test('时间：ISO 换成好读的样子；没有时间就说没有（不拿"现在"冒充）', () => {
  assert.equal(timeText('2026-09-29T21:58:14'), '2026-09-29 21:58:14');
  assert.equal(timeText(null), '（没有时间）');
});

test('★ 条件句**常驻**：没筛也要说「没有筛选条件」，筛了要说全条件', () => {
  const noCond = filterLine({}, 22, 22, INDEX);
  assert.equal(noCond, '显示 22 / 共 22 条（没有筛选条件）');

  const cond = { key: 'door.openOkDeg', from: '2026-09-01', to: '2026-09-29' };
  const line = filterLine(cond, 6, 6, INDEX);
  assert.match(line, /^显示 6 \/ 共 6 条（条件：/);
  assert.match(line, /项：.+（door\.openOkDeg）/);
  assert.match(line, /从 2026-09-01/);
  assert.match(line, /到 2026-09-29（含当天）/, '只给日期时必须写明"含当天"，否则用户不知道这一天的算不算');
  assert.equal(isFiltered(cond), true);
  assert.equal(isFiltered({}), false);
  assert.equal(condParts({ by: '1', byName: '本机用户' })[0], '人：本机用户（#1）');
});

test('★ 空态说清是**哪一种**空：库里就没有 vs 被条件筛没了（要给出"去掉条件还有多少"）', () => {
  assert.match(emptyText({}, 0), /一条留痕都没有/);
  const filtered = emptyText({ key: 'room.minW' }, 22);
  assert.match(filtered, /没有符合这些条件的留痕/);
  assert.match(filtered, /去掉条件能看到 22 条/);
  // 拿不到"一共多少条"时不许拿 0 冒充
  assert.match(emptyText({ key: 'room.minW' }, null), /去掉条件，看看一共有多少条/);
});

test('翻页那一行：数字要对得上（第几条到第几条 / 共几条 / 第几页）', () => {
  assert.equal(pageText(0, 20, 22), '第 1–20 条 / 共 22 条 · 第 1 / 2 页');
  assert.equal(pageText(20, 20, 22), '第 21–22 条 / 共 22 条 · 第 2 / 2 页');
  assert.equal(pageText(0, 20, 7), '第 1–7 条 / 共 7 条');
  assert.equal(pageText(0, 20, 0), '没有留痕');
});

test('★ 快照：35 项全在，改的那一项标出来；**留痕与快照对不上要敢说**', () => {
  const snap = { ...SCHEMA.defaults, door: { ...SCHEMA.defaults.door, openOkDeg: 85 } };
  const flat = {};
  for (const [g, items] of Object.entries(snap)) for (const [k, v] of Object.entries(items)) flat[g + '.' + k] = v;

  const rows = snapshotRows(flat, SCHEMA, ROW);
  assert.equal(rows.length, SCHEMA.flat.length, '快照要摆出全部项（B4d 靠它复现当时的结论）');
  const hit = rows.find((r) => r.path === 'door.openOkDeg');
  assert.equal(hit.changed, true);
  assert.equal(hit.mismatch, false, '留痕说改成 85、快照里也是 85 → 不该报不一致');
  assert.equal(hit.value, '85°');
  assert.equal(rows.filter((r) => r.changed).length, 1, '一次只改一项，高亮就只能有一行');

  // 故意把两处写岔：界面必须报出来（这种岔只有"两份放一起看"才发现）
  const bad = snapshotRows(flat, SCHEMA, { ...ROW, newValue: 80 });
  assert.equal(bad.find((r) => r.path === 'door.openOkDeg').mismatch, true);
  assert.match(bad.find((r) => r.path === 'door.openOkDeg').expected, /80/);
});

test('没有快照时：说"没有"，不拿一份默认值顶替', () => {
  assert.deepEqual(snapshotRows(null, SCHEMA, ROW), []);
  assert.deepEqual(snapshotRows({}, SCHEMA, ROW), []);
});