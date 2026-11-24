import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_DRAFT, STATUS_DELIVERED, STATUS_ORDER, STATUS_LABEL,
  SORTS, SORT_ORDER, SORT_LABEL,
  statusLabel, actorLabel, ownerLabel, sizeText, itemCountOf, roomCountOf,
  modelCodesFromItems, modelCodesOf, modelCountOf,
  tagsOf, timeText, hasCover, coverSizeText, coverUrl, coverTitle, deletedFlag,
  statusOf, auditBadge, statusCounts, filterSchemes, filterSummary, sortSchemes, cardOf,
  summarizeCards, modelOptions,
  revisionOf, historySummary, historyNote,
  rollbackConfirmText, rollbackDoneText, duplicateDoneText, deleteDoneText,
} from '../src/admin/schemes.js';

/* 这里是「方案库列表要回答的判断」的钉子。全部钉**字面量**，不读实现的常量 ——
   读常量就抓不到「常量本身被改错」。

   ⚠️ 夹具是**真数据**：下面 ACTIVE 那一份是从本机后端 `GET /api/schemes` 直接抄下来的
   （2026-09-28 实测，scheme id=5），不是我编的。
   编的夹具会把「接口其实不给这个字段」这类**真问题一起编掉** —— 这一轮已经吃过一次亏：
   设计里写「型号数：客户端算」，而接口根本不发 items。 */

const ACTIVE = {
  "id": 5,
  "name": "冷藏库房 B 区（重启后应还在）",
  "room": {
    "w": 8,
    "d": 7,
    "h": 2.8
  },
  "itemCount": 3,
  "audit": {
    "items": 3,
    "issues": 0,
    "trouble": 1,
    "clean": true
  },
  "rev": 1,
  "coverFile": "",
  "coverSize": 0,
  "status": "draft",
  "updatedBy": "",
  "createdAt": "2026-09-23T10:22:25.686",
  "updatedAt": "2026-09-24T14:03:37.192"
};

/* ---------- 词表 ---------- */

test('状态词表只有两档，且 submitted 刻意不在里面', () => {
  assert.deepEqual(STATUS_ORDER, ['draft', 'delivered']);
  assert.equal(STATUS_DRAFT, 'draft');
  assert.equal(STATUS_DELIVERED, 'delivered');
  assert.equal(STATUS_LABEL.submitted, undefined, 'submitted 没有入口能到达，不该出现在词表里');
  assert.deepEqual(Object.keys(STATUS_LABEL).sort(), ['delivered', 'draft']);
});

test('排序维度只有三个，且顺序与设计一致', () => {
  assert.deepEqual(SORT_ORDER, ['updated', 'created', 'scale']);
  assert.equal(SORTS.SCALE, 'scale');
  assert.deepEqual(Object.values(SORT_LABEL), ['最近更新', '最近创建', '规模（台数）']);
});

test('状态码 → 人话：认识的翻，不认识的说「未知」而不是假装认识', () => {
  assert.equal(statusLabel('draft'), '草稿');
  assert.equal(statusLabel('delivered'), '已交付');
  assert.equal(statusLabel('submitted'), '未知（submitted）');
  assert.equal(statusLabel(''), '—');
  assert.equal(statusLabel(null), '—');
  assert.equal(statusLabel('  draft  '), '草稿', '两侧空白不该让状态变成未知');
});

/* ---------- 谁改的 / 什么时候 ---------- */

test('「最近谁改的」：空就是空，不补人名', () => {
  assert.equal(actorLabel(''), '—', '老数据是空串（B3 之前没人写过）');
  assert.equal(actorLabel(null), '—');
  assert.equal(actorLabel('  '), '—');
  assert.equal(actorLabel('7'), '#7', '认得的翻成人话，不认得的原样带 # —— 绝不猜');
  // U1：`1` 曾特判成「本机用户」（单用户档的遗留）。现在 id 1 只是普通账号之一，
  // 特判会把某个人的方案说成"本机的"，而归属正是本批要讲清的事
  assert.equal(actorLabel('1'), '#1', 'id 1 不再特判 —— 归属按服务端给的 ownerName 显示');
});

test('归属人：服务端给了名字就用名字，没给就回 id，都没给才是「—」', () => {
  assert.equal(ownerLabel({ ownerName: 'admin' }), 'admin');
  assert.equal(ownerLabel({ ownerId: 7 }), '#7', '没给名字时回 id —— 不编一个名字出来');
  assert.equal(ownerLabel({ ownerName: '', ownerId: 1 }), '#1', '空名字与没给名字同样处理');
  assert.equal(ownerLabel({}), '—');
  assert.equal(ownerLabel(null), '—');
});

test('时间：与前台方案表同一条规则（月-日 时:分）', () => {
  assert.equal(timeText('2026-09-24T14:03:37.192'), '09-24 14:03');
  assert.equal(timeText(''), '—');
  assert.equal(timeText(null), '—');
});

/* ---------- 尺寸 / 台数 ---------- */

test('房间尺寸：真样本逐字对得上，且带单位', () => {
  assert.equal(sizeText(ACTIVE.room), '8 × 7 × 2.8 m');
  assert.equal(sizeText({ w: 5, d: 4, h: 2.6 }), '5 × 4 × 2.6 m');
  assert.equal(sizeText({ w: 8.25, d: 7, h: 2.8 }), '8.3 × 7 × 2.8 m', '四舍五入到一位小数');
});

test('房间尺寸：缺数就说「—」，不编一个 0 出来', () => {
  assert.equal(sizeText({ w: 8, d: 7 }), '—');
  assert.equal(sizeText({ w: 8, d: 7, h: 'x' }), '—');
  assert.equal(sizeText(null), '—');
  assert.equal(sizeText(undefined), '—');
});

test('台数：优先用服务端算好的那个数', () => {
  assert.equal(itemCountOf(ACTIVE), 3);
  assert.equal(itemCountOf({ itemCount: 0 }), 0, '0 台是有效值，不是"没有"');
});

test('台数：接口没给就回 null —— 0 台和「不知道几台」是两件事', () => {
  assert.equal(itemCountOf({}), null);
  assert.equal(itemCountOf({ itemCount: 'x' }), null);
  assert.equal(itemCountOf(null), null);
});

/* ---------- 型号 ---------- */

test('型号数：型号在 item.p 里，不在 item.id 里（实测样本）', () => {
  // 这三个 item 就是 scheme id=2 的 room_json.items 原样：p=demo-ct-scanner/demo-freezer-dual/demo-freezer-chest，id=1/2/3
  const items = [
    { p: 'demo-ct-scanner', r: 0.0, x: 0.7, z: 0.7, id: 1 },
    { p: 'demo-freezer-dual', r: 90.0, x: 1.9, z: 0.7, id: 2 },
    { p: 'demo-freezer-chest', r: 0.0, x: 5.0, z: 4.0, id: 3 },
  ];
  assert.deepEqual(modelCodesFromItems(items), ['demo-ct-scanner', 'demo-freezer-dual', 'demo-freezer-chest']);
});

test('型号去重：两台同型号算 1 个型号（拿 id 数就会数成 2）', () => {
  const same = [
    { p: 'demo-ct-scanner', id: 1 },
    { p: 'demo-ct-scanner', id: 2 },
  ];
  assert.equal(modelCodesFromItems(same).length, 1);
  const two = [
    { p: 'demo-ct-scanner', id: 1 },
    { p: 'demo-freezer-chest', id: 2 },
  ];
  assert.equal(modelCodesFromItems(two).length, 2);
});

test('型号数：列表行没有 modelCodes；来源是 服务端给的 > state.items > 不知道', () => {
  assert.equal(modelCodesOf(ACTIVE), null, 'ACTIVE 是原样的列表行，接口还没给 modelCodes');
  assert.equal(
    modelCodesOf({ modelCodes: ['a', 'b'] }).join(','), 'a,b',
    '接口给了就用它 —— 不在客户端重算同一个数',
  );
  assert.deepEqual(
    modelCodesOf({ state: { items: [{ p: 'x' }, { p: 'x' }, { p: 'y' }] } }), ['x', 'y'],
    '详情接口给完整 state 时才自己数',
  );
  assert.equal(modelCodesOf({ modelCodes: null, state: null }), null);
});

test('型号数：未知回 null（不是 0）', () => {
  assert.equal(modelCountOf(ACTIVE), null);
  assert.equal(modelCountOf({ modelCodes: ['a', 'b', 'c'] }), 3);
  assert.equal(modelCountOf({ modelCodes: [] }), 0, '接口明说"没有型号"才是 0');
});

test('型号：空串与空白型号不算一个型号', () => {
  assert.deepEqual(modelCodesFromItems([{ p: '  ' }, { p: '' }, { p: null }, { p: 'demo-ct-scanner' }]), ['demo-ct-scanner']);
  assert.deepEqual(modelCodesFromItems(null), []);
  assert.deepEqual(modelCodesFromItems('not an array'), []);
});

/* ---------- 标签 / 封面 / 软删 ---------- */

test('标签：认两种形状，坏 JSON 不抛错也不算标签', () => {
  assert.deepEqual(tagsOf({ tags: null }), []);
  assert.deepEqual(tagsOf({ tags: ['重点', '已报价'] }), ['重点', '已报价']);
  assert.deepEqual(tagsOf({ tags: '["重点","已报价"]' }), ['重点', '已报价'], '接口现在原样发 JSON 文本');
  assert.deepEqual(tagsOf({ tags: '{"not":"array"}' }), []);
  assert.deepEqual(tagsOf({ tags: '这不是 JSON' }), []);
  assert.deepEqual(tagsOf(ACTIVE), [], '真样本的 tags 是 null');
});

test('封面：没有就是没有，大小显示「—」而不是 0 B', () => {
  assert.equal(hasCover(ACTIVE), false, '老的 5 条都没有封面');
  assert.equal(hasCover({ coverFile: '  ' }), false);
  assert.equal(hasCover({ coverFile: 'assets/thumbs/1.png' }), true);
  assert.equal(coverSizeText(ACTIVE), '—');
  assert.equal(coverSizeText({ coverFile: 'a.png', coverSize: 2048 }), '2.0 KB');
});

test('封面 URL（R6-3 3f）：文件名固定 → 必须带内容指纹当缓存键，否则用户一直看旧图', () => {
  assert.equal(
    coverUrl({ id: 5, coverFile: 'assets/covers/5.png', coverChecksum: 'abcdef0123456789abcdef0123456789' }),
    '/api/schemes/5/cover?v=abcdef0123456789abcdef0123456789');
  assert.equal(coverUrl({ id: 5, coverFile: '', coverChecksum: '' }), '',
    '没有封面 → 空串（调用方据此显示占位，不假渲一张）');
  assert.equal(coverUrl({ id: 7, coverFile: 'assets/covers/7.png', coverChecksum: '' }),
    '/api/schemes/7/cover',
    '有图但指纹缺失（老数据）→ 不带 v：宁可多取一次，也不要**猜**一个键（猜错的表现是"封面永远是旧的"）');
  assert.notEqual(
    coverUrl({ id: 5, coverFile: 'x', coverChecksum: 'a'.repeat(32) }),
    coverUrl({ id: 5, coverFile: 'x', coverChecksum: 'b'.repeat(32) }),
    '指纹一变 URL 必须跟着变，否则用户换了封面却一直看缓存里的旧图');
  assert.equal(coverUrl({ id: 9, coverFile: 'a.png', coverChecksum: 'a'.repeat(32) }),
    '/api/schemes/9/cover?v=' + 'a'.repeat(32), 'URL 按方案 id 走（封面是每个方案一张）');
});

test('封面话术：不许出现「版」—— 封面不跟版本走（用户拍板 2026-09-29）', () => {
  // 话术本身也是判据：把一张"最新一次截的图"说成"这一版的封面"就是假话，
  // 所以这里连"能不能出现「版」字"都钉住了。
  const covered = coverTitle({ coverFile: 'assets/covers/5.png', coverSize: 307200, coverChecksum: 'a'.repeat(32) });
  // 话术随实现改过一次（2026-10-07）：封面改成**固定正面斜 45°**（与交付包第一张同机位）——
  // 因为"保存那一刻的三维视角"在平面图里保存时根本截不到，维护端列表永远没有封面。
  // ⚠️ 改的是"怎么来的"，不是"跟不跟版本走"：下面那条「不许出现『版』」仍然钉着。
  assert.match(covered, /固定正面斜 45° 视角/);
  assert.match(covered, /与交付包第一张同机位/);
  assert.ok(!covered.includes('版'),
    '封面话术里不能出现「版」字：封面不跟版本走（用户拍板），把它说成"这一版的封面"是假话');
  assert.match(coverTitle({ coverFile: '' }), /不假渲一张/);
});

test('软删旗标：boolean / 1 / 字符串都能认出来', () => {
  assert.equal(deletedFlag({ deleted: true }), true);
  assert.equal(deletedFlag({ deleted: 1 }), true);
  assert.equal(deletedFlag({ deleted: '1' }), true);
  assert.equal(deletedFlag({ deleted: 'true' }), true);
  assert.equal(deletedFlag({ deleted: 0 }), false);
  assert.equal(deletedFlag(ACTIVE), false);
  assert.equal(deletedFlag(null), false);
});

/* ---------- 角标：判据必须与前台那句话逐字一致 ---------- */

test('体检角标：放不下优先于门 —— 两件事同时有，先说「放不下」', () => {
  const b = auditBadge({ items: 3, issues: 2, trouble: 1, clean: false });
  assert.equal(b.level, 'bad');
  assert.equal(b.text, '放不下 2');
  assert.equal(b.why, '2 台放不下（越界 / 占地重叠 / 压内墙）');
});

test('体检角标：真样本是「门 1」（摆得下，但有一台门开不到 90°）', () => {
  const b = auditBadge(ACTIVE.audit);
  assert.equal(b.level, 'warn');
  assert.equal(b.text, '门 1');
  assert.equal(b.why, '1 台的门开不到 90° —— 摆得下，但用起来别扭');
});

test('体检角标：干净就说干净，但「干净」不等于「这方案好」', () => {
  const b = auditBadge({ items: 3, issues: 0, trouble: 0, clean: true });
  assert.equal(b.level, 'ok');
  assert.equal(b.text, 'ok');
  assert.equal(b.why, '摆得合规，且门都开得到底');
});

test('体检角标：没有结论就说没有，不冒充「干净」', () => {
  const b = auditBadge(null);
  assert.equal(b.level, 'none');
  assert.equal(b.text, '—');
  assert.ok(!/合规/.test(b.why), '没算过就不能说它合规');
});

test('体检角标：字段缺失当 0，但坏值不会被当成「有」', () => {
  assert.equal(auditBadge({ items: 3 }).level, 'ok');
  assert.equal(auditBadge({ issues: 'x' }).level, 'ok');
  assert.equal(auditBadge({ trouble: 2 }).level, 'warn');
});

/* ---------- 筛选标签 ---------- */

test('筛选标签：从数据里现算，词表里的档（含 0）都留着', () => {
  const tabs = statusCounts([{ status: 'draft' }, { status: 'draft' }, ACTIVE]);
  assert.deepEqual(tabs, [
    { code: 'draft', label: '草稿', count: 3 },
    { code: 'delivered', label: '已交付', count: 0 },
  ]);
});

test('筛选标签：词表外的状态追加在后面，不许被悄悄过滤掉', () => {
  const tabs = statusCounts([{ status: 'draft' }, { status: 'archived' }]);
  assert.equal(tabs.length, 3);
  assert.equal(tabs[1].count, 0, '词表里的 delivered 仍在第二位');
  assert.equal(tabs[2].code, 'archived');
  assert.equal(tabs[2].label, '未知（archived）');
  assert.equal(tabs[2].count, 1);
});

test('筛选标签：空数据也要给出词表，界面不该因为这个崩', () => {
  assert.deepEqual(statusCounts([]).map((t) => t.code), ['draft', 'delivered']);
  assert.deepEqual(statusCounts([]).map((t) => t.count), [0, 0]);
  assert.equal(statusCounts(null).length, 2);
});

test('状态码：两侧空白不影响匹配', () => {
  assert.equal(statusOf({ status: ' draft ' }), 'draft');
  assert.equal(statusOf({}), '');
});

/* ---------- 筛选 ---------- */

const LIB = [
  { id: 5, name: 'A 库房', status: 'draft', room: { w: 8, d: 7, h: 2.8 }, itemCount: 3,
    modelCodes: ['demo-ct-scanner', 'demo-freezer-dual', 'demo-freezer-chest'],
    updatedAt: '2026-09-24T14:03:37.192', createdAt: '2026-09-23T10:22:25.686' },
  { id: 2, name: 'B 库房', status: 'draft', room: { w: 8, d: 7, h: 2.8 }, itemCount: 3,
    modelCodes: ['demo-ct-scanner'],
    updatedAt: '2026-09-24T14:03:37.192', createdAt: '2026-09-23T09:42:33.955' },
  { id: 7, name: '冷库 C', status: 'delivered', room: { w: 5, d: 4, h: 2.6 }, itemCount: 1,
    modelCodes: ['demo-freezer-chest'], tags: ['重点'],
    updatedAt: '2026-09-20T08:00:00.000', createdAt: '2026-09-19T08:00:00.000' },
];

test('筛选：空条件等于不筛', () => {
  assert.equal(filterSchemes(LIB, {}).length, 3);
  assert.equal(filterSchemes(LIB, null).length, 3);
  assert.equal(filterSchemes(LIB, { q: '  ', status: '', model: '' }).length, 3);
});

test('筛选：按状态', () => {
  assert.deepEqual(filterSchemes(LIB, { status: 'delivered' }).map((r) => r.id), [7]);
  assert.deepEqual(filterSchemes(LIB, { status: 'draft' }).map((r) => r.id), [5, 2]);
});

test('筛选：含某型号', () => {
  assert.deepEqual(filterSchemes(LIB, { model: 'demo-ct-scanner' }).map((r) => r.id), [5, 2]);
  assert.deepEqual(filterSchemes(LIB, { model: 'demo-freezer-chest' }).map((r) => r.id), [5, 7]);
  assert.deepEqual(filterSchemes(LIB, { model: 'demo-999' }).map((r) => r.id), []);
});

test('筛选：文本匹配方案名 / 型号码 / 标签，且大小写不敏感', () => {
  assert.deepEqual(filterSchemes(LIB, { q: '库房' }).map((r) => r.id), [5, 2]);
  assert.deepEqual(filterSchemes(LIB, { q: 'DEMO-CT' }).map((r) => r.id), [5, 2]);
  assert.deepEqual(filterSchemes(LIB, { q: '重点' }).map((r) => r.id), [7]);
});

test('筛选：**刻意不匹配 id** —— 「搜不到」这件事本身是被写下来的', () => {
  // 用 7 试：LIB 里 id=7 的那一行，可搜文本是「冷库 C / demo-freezer-chest / 重点」，都不含 7
  assert.deepEqual(filterSchemes(LIB, { q: '7' }).map((r) => r.id), [], 'id 不是给人找东西用的');
  // ⚠️ 顺便记一个**我一开始想当然写错的期望**：我本打算用 q='5'，以为谁都不含 5 ——
  //    结果它命中了型号 demo-freezer-dual 和 demo-freezer-chest。这不是实现的毛病，是"型号码里本来就有数字"。
  //    写这条测试的正确姿势，就是**选一个真的不在任何可搜文本里出现的数**。
  // 合成型号（demo-*）里已经不出现数字，所以这条历史上「数字命中型号」的现象**复现不了**：
  // 现在任何单个数字都搜不到东西 —— 期望值随之改成空数组，规则本身没变。
  assert.deepEqual(filterSchemes(LIB, { q: '5' }).map((r) => r.id), [], '合成型号里没有数字，搜数字就不该命中');
});

test('台数：null / 空串都不算数（Number(null) 是 0 —— 这个坑被钉住了）', () => {
  assert.equal(itemCountOf(null), null);
  assert.equal(itemCountOf(undefined), null);
  assert.equal(itemCountOf({ itemCount: '' }), null);
  assert.equal(itemCountOf({ itemCount: null }), null);
});

test('筛选：多个条件是「且」', () => {
  assert.deepEqual(filterSchemes(LIB, { status: 'draft', model: 'demo-freezer-chest' }).map((r) => r.id), [5]);
  assert.deepEqual(filterSchemes(LIB, { status: 'delivered', model: 'demo-ct-scanner' }).map((r) => r.id), []);
});

test('筛选：坏行不会让整个列表崩', () => {
  assert.deepEqual(filterSchemes([null, undefined, LIB[0]], {}).map((r) => r && r.id), [5]);
  assert.equal(filterSchemes(null, {}).length, 0);
});

/* ---------- 筛选说明（不许静默） ---------- */

test('筛选说明：没筛就说共几份', () => {
  assert.equal(filterSummary(3, 3, {}), '共 3 份');
  assert.equal(filterSummary(3, 3, null), '共 3 份');
});

test('筛选说明：筛了就说「显示几条 / 共几条 + 按什么条件」', () => {
  assert.equal(filterSummary(1, 3, { status: 'delivered' }), '显示 1 / 共 3 份（条件：状态 = 已交付）');
  assert.equal(filterSummary(2, 3, { model: 'demo-ct-scanner' }), '显示 2 / 共 3 份（条件：含型号 demo-ct-scanner）');
  assert.equal(filterSummary(1, 3, { q: '冷库' }), '显示 1 / 共 3 份（条件：文本含「冷库」）');
});

test('筛选说明：多个条件一次说全（不是只说最后一个）', () => {
  assert.equal(
    filterSummary(1, 3, { status: 'draft', model: 'demo-ct-scanner', q: 'A' }),
    '显示 1 / 共 3 份（条件：文本含「A」、状态 = 草稿、含型号 demo-ct-scanner）',
  );
});

test('筛选说明：筛完一条不剩也要说清楚（最容易被忽略的那种）', () => {
  assert.equal(filterSummary(0, 3, { model: 'demo-999' }), '显示 0 / 共 3 份（条件：含型号 demo-999）');
});

/* ---------- 排序 ---------- */

test('排序：最近更新倒序，并列时按 id 兜底（否则卡片会自己换位置）', () => {
  const out = sortSchemes(LIB, SORTS.UPDATED);
  assert.deepEqual(out.map((r) => r.id), [5, 2, 7], '5 与 2 的 updatedAt 相同 → id 大的在前');
});

test('排序：最近创建', () => {
  assert.deepEqual(sortSchemes(LIB, SORTS.CREATED).map((r) => r.id), [5, 2, 7]);
});

test('排序：规模（台数），台数缺失的排最后', () => {
  const withUnknown = LIB.concat([{ id: 9, name: '没给台数', updatedAt: '2026-09-25T00:00:00.000' }]);
  assert.deepEqual(
    sortSchemes(withUnknown, SORTS.SCALE).map((r) => r.id),
    [5, 2, 7, 9],
    '不知道几台的，不该混在「很少几台」里',
  );
});

test('排序：不认识的排序名退回「最近更新」，不报错', () => {
  assert.deepEqual(sortSchemes(LIB, 'nonsense').map((r) => r.id), [5, 2, 7]);
  assert.deepEqual(sortSchemes(LIB, undefined).map((r) => r.id), [5, 2, 7]);
});

test('排序：**不动入参**（列表是界面状态）', () => {
  const input = LIB.slice();
  const before = input.map((r) => r.id);
  sortSchemes(input, SORTS.SCALE);
  assert.deepEqual(input.map((r) => r.id), before, '排序顺手改了原数组，会让人在别处看到顺序自己变了');
});

test('排序：空列表与坏入参不崩', () => {
  assert.deepEqual(sortSchemes([], SORTS.UPDATED), []);
  assert.deepEqual(sortSchemes(null, SORTS.UPDATED), []);
});

/* ---------- 卡片 ---------- */

test('卡片：真样本逐字段对得上', () => {
  const c = cardOf(ACTIVE);
  assert.equal(c.id, 5);
  assert.equal(c.rev, 1);
  assert.equal(c.statusCode, 'draft');
  assert.equal(c.statusLabel, '草稿');
  assert.equal(c.sizeText, '8 × 7 × 2.8 m');
  assert.equal(c.itemCount, 3);
  assert.equal(c.modelCount, null, '接口没给 modelCodes → 未知，不是 0');
  assert.deepEqual(c.modelCodes, []);
  assert.deepEqual(c.tags, []);
  assert.equal(c.hasCover, false);
  assert.equal(c.coverSizeText, '—');
  assert.equal(c.actor, '—', '老数据 updated_by 是空串');
  assert.equal(c.updatedText, '09-24 14:03');
  assert.equal(c.createdText, '09-23 10:22');
  assert.equal(c.audit.level, 'warn');
  assert.equal(c.deleted, false);
});

test('卡片：型号数能给出来时就是数字', () => {
  const c = cardOf(LIB[0]);
  assert.equal(c.modelCount, 3);
  assert.deepEqual(c.modelCodes, ['demo-ct-scanner', 'demo-freezer-dual', 'demo-freezer-chest']);
});

test('卡片：空行不崩', () => {
  const c = cardOf(null);
  assert.equal(c.name, '');
  assert.equal(c.sizeText, '—');
  assert.equal(c.itemCount, null);
  assert.equal(c.audit.level, 'none');
});

/* ---------- 汇总（3d） ---------- */

/* 三份真样本的角标情形，逐字取自后端 `audit` 的形状：
   id=5 门 1（warn）· 另一份放不下 2（bad）· 第三份没有体检结论（none） */
const CARDS = [
  cardOf({ id: 5, name: 'A', audit: { items: 3, issues: 0, trouble: 1, clean: true } }),
  cardOf({ id: 2, name: 'B', audit: { items: 3, issues: 2, trouble: 1, clean: false } }),
  cardOf({ id: 7, name: 'C', audit: null }),
];

test('汇总：单位是「份」不是「个角标」—— 一份方案只算一次', () => {
  const s = summarizeCards(CARDS);
  assert.equal(s.total, 3);
  assert.equal(s.bad, 1, 'id=2 放不下 2 台 → 1 份');
  assert.equal(s.warn, 1, 'id=5 门 1 → 1 份');
  assert.equal(s.noAudit, 1, 'id=7 没有体检结论');
  assert.equal(s.ok, 0);
  assert.equal(s.bad + s.warn + s.ok + s.noAudit, s.total, '四档加起来必须等于总数（漏一类就会被少算）');
});

test('汇总：放不下优先于门 —— 同一份不会既算 bad 又算 warn', () => {
  const both = cardOf({ id: 1, audit: { items: 3, issues: 2, trouble: 1, clean: false } });
  const s = summarizeCards([both]);
  assert.equal(s.bad, 1);
  assert.equal(s.warn, 0, '两个毛病同时有，按严重的那个归档 —— 否则四档加起来会超过总数');
});

test('汇总：干净的那档要真的能数出来（不许把「没毛病」也算进坏档）', () => {
  const s = summarizeCards([cardOf({ id: 1, audit: { items: 3, issues: 0, trouble: 0, clean: true } })]);
  assert.equal(s.ok, 1);
  assert.equal(s.bad, 0);
  assert.equal(s.warn, 0);
  assert.equal(s.noAudit, 0);
});

test('汇总：空列表与坏入参不崩', () => {
  assert.deepEqual(summarizeCards([]), { total: 0, bad: 0, warn: 0, ok: 0, noAudit: 0 });
  assert.equal(summarizeCards(null).total, 0);
  assert.equal(summarizeCards([null, undefined]).total, 0, '坏行不算一份');
});

test('汇总：没算过体检的**不许算进「干净」**（那等于替它打包票）', () => {
  assert.equal(summarizeCards([cardOf({ id: 1 })]).ok, 0);
  assert.equal(summarizeCards([cardOf({ id: 1 })]).noAudit, 1);
});

/* ---------- 型号选项（3d） ---------- */

test('型号选项：从数据里现算、去重、排序（不硬列清单）', () => {
  assert.deepEqual(modelOptions(LIB), ['demo-ct-scanner', 'demo-freezer-chest', 'demo-freezer-dual'], '按字母序，两次渲染顺序一致');
});

test('型号选项：型号未知的行一个都不贡献（不编）', () => {
  assert.deepEqual(modelOptions([ACTIVE]), [], 'ACTIVE 是原样列表行，接口没给 modelCodes');
  assert.deepEqual(modelOptions([]), []);
  assert.deepEqual(modelOptions(null), []);
});

test('型号选项：接口给了空数组的行也不贡献（「没有型号」不等于「有个空型号」）', () => {
  assert.deepEqual(modelOptions([{ modelCodes: [] }, { modelCodes: ['demo-ct-scanner'] }]), ['demo-ct-scanner']);
});

/* ---------- R6-3 3e：版本历史与三个写动作的话术 ---------- */

/* 夹具形状来自**后端真接口**（`GET /api/schemes/{id}/revisions`，3e 起每行带摘要 + isCurrent）。
   为什么一定要带 room/itemCount/modelCodes 三样：回滚是个**必须做的选择**，
   没有摘要的话"第 3 版 / 第 4 版"在界面上长得一模一样。 */

const REV3 = {
  rev: 3, note: '回滚到第 1 版', createdAt: '2026-09-29T06:10:00',
  paramsRev: 111, room: { w: 8, d: 6, h: 2.8 }, itemCount: 3,
  modelCodes: ['demo-ct-scanner', 'demo-freezer-dual'], isCurrent: true,
};
const REV2 = {
  rev: 2, note: '改房间', createdAt: '2026-09-28T10:00:00',
  paramsRev: 222, room: { w: 9, d: 7, h: 3 }, itemCount: 4,
  modelCodes: ['demo-ct-scanner'], isCurrent: false,
};
const REV1 = {
  rev: 1, note: '创建', createdAt: '2026-09-27T09:00:00',
  paramsRev: 111, room: { w: 8, d: 6, h: 2.8 }, itemCount: 0,
  modelCodes: [], isCurrent: false,
};

test('版本行：摘要来自这一版自己的快照，不是最后一版', () => {
  assert.equal(revisionOf(REV1).sizeText, '8 × 6 × 2.8 m');   // 8.0 显示成 8，见 sizeText 的口径
  assert.equal(revisionOf(REV2).sizeText, '9 × 7 × 3 m');
  assert.equal(revisionOf(REV1).itemCount, 0);
  assert.equal(revisionOf(REV2).itemCount, 4);
  assert.equal(revisionOf(REV2).modelCount, 1);
  assert.equal(revisionOf(REV1).modelCount, 0);
});

test('版本行：isCurrent 只认 === true（缺字段不许当成"就是当前版"）', () => {
  assert.equal(revisionOf(REV3).isCurrent, true);
  assert.equal(revisionOf(REV2).isCurrent, false);
  assert.equal(revisionOf({ rev: 4 }).isCurrent, false);
});

test('版本行：空行与坏入参不崩', () => {
  const r = revisionOf(null);
  assert.equal(r.rev, 0);
  assert.equal(r.note, '');
  assert.equal(r.itemCount, null);
  assert.equal(r.modelCount, null);
  assert.equal(revisionOf(undefined).rev, 0);
});

test('历史完整性：全都在 → 说"完整"，不留尾巴', () => {
  const rows = [REV1, REV2, REV3].map(revisionOf);
  const s = historySummary(rows, 3);
  assert.deepEqual(s, { count: 3, current: 3, missing: [] });
  assert.equal(historyNote(rows, 3), '版本历史完整：第 1–3 版都有留存，都能回滚。');
});

test('历史完整性：缺哪一版就报哪一版（老方案真的缺，不补）', () => {
  // 实测形态：5 条方案 / 7 条留痕 —— 导入进来的那批就是只有部分版本
  const rows = [REV1, REV3].map(revisionOf);
  const s = historySummary(rows, 3);
  assert.deepEqual(s.missing, [2]);
  assert.match(historyNote(rows, 3), /留存的只有 2 版/);
  assert.match(historyNote(rows, 3), /缺第 2 版/);
  assert.match(historyNote(rows, 3), /缺就是缺/);
});

test('历史完整性：缺口多的时候一次列全，不是只报第一个', () => {
  const rows = [revisionOf({ rev: 5, room: {}, itemCount: 0, modelCodes: [] })];
  assert.deepEqual(historySummary(rows, 5).missing, [1, 2, 3, 4]);
  assert.match(historyNote(rows, 5), /缺第 1、2、3、4 版/);
});

test('历史完整性：一份都没有时的说法与"缺版本"是两句不同的话', () => {
  assert.equal(historyNote([], 0), '这份方案还没有版本记录。');
  assert.equal(historySummary([], 3).count, 0);
  assert.deepEqual(historySummary([], 3).missing, [1, 2, 3]);
});

test('回滚确认话术：把「变成什么样」和「当前那版会先留存」两件事都说出来', () => {
  const t = rollbackConfirmText(revisionOf(REV1), 3);
  assert.match(t, /回滚到第 1 版/);
  assert.match(t, /8 × 6 × 2\.8 m/);
  assert.match(t, /0 台/);
  assert.match(t, /当前的第 3 版会\*\*先自动留存一版\*\*，不会丢/);
});

test('回滚确认话术：摘要缺失时说清"只能按版本号认"，不假装知道', () => {
  const t = rollbackConfirmText({ rev: 2, sizeText: '', itemCount: null, modelCount: null }, 5);
  assert.match(t, /回滚到第 2 版/);
  assert.match(t, /这一版没给摘要，只能按版本号认/);
  // 台数为 0 是**数字**，必须说出来；null（接口没给）才是不说 —— 两者不能混
  const zero = rollbackConfirmText({ rev: 2, sizeText: '8 × 6 × 2.8 m', itemCount: 0, modelCount: 0 }, 5);
  assert.match(zero, /0 台/);
});

test('回滚回执：区分「本来就有」与「本次补存」—— 后者才需要谢服务端', () => {
  const existing = rollbackDoneText({ rev: 6, rolledBackTo: 2, keptRev: 5, keptWasExisting: true });
  assert.match(existing, /已回滚到第 2 版 → 现在是第 6 版/);
  assert.match(existing, /第 5 版本来就在历史里（没有额外动作）/);
  const saved = rollbackDoneText({ rev: 6, rolledBackTo: 2, keptRev: 5, keptWasExisting: false });
  assert.match(saved, /第 5 版历史里没有，\*\*已自动补存一版\*\*/);
});

test('复制回执：说清它来自哪一份哪一版（不说，过两天就会怀疑拷错了）', () => {
  const t = duplicateDoneText({ id: 57, name: '冷藏库房 B 区 副本', fromId: 5, fromRev: 3 });
  assert.match(t, /已复制为 #57「冷藏库房 B 区 副本」/);
  assert.match(t, /来自 #5 第 3 版/);
  assert.match(t, /副本状态是草稿、没有封面也不带标签/);
});

test('删除 / 恢复回执：方向不同、话说不同，且都要说清"没有真删掉"', () => {
  assert.match(deleteDoneText(5, false), /#5 已放进回收站/);
  assert.match(deleteDoneText(5, false), /没有真删掉/);
  assert.match(deleteDoneText(5, true), /#5 已从回收站恢复/);
  assert.match(deleteDoneText(5, true), /版本号没有变/);
});
