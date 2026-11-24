/**
 * draft.test.js —— 未保存草稿的判据（键、编解码、恢复前的内核校验）
 *
 * 这一层错起来**界面上看不出来**，所以每条都要钉：
 *   · 键里没带账号 id → 换个人登录就读到上一个人的草稿，而他只会觉得"系统自己打开了别人的方案"；
 *   · 半份草稿被恢复进去 → 编辑器带着一份残缺布局继续跑，保存下去就写进库里；
 *   · 写入失败被吞掉 → 刷完页面改动没了，而用户以为"它一直存着"。
 *
 * 存储由调用方注入（`createDraftStore(storage, userId)`）：node 里没有 `localStorage`，
 * 而键名与编解码必须被逐条钉住。下面那个 `memStorage` 是一份真实现（不是替身），
 * 只把"存哪儿"换成内存。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as room from '@core/room.js';
import * as scheme from '@core/scheme.js';
import {
  DRAFT_PREFIX, DRAFT_VERSION, createDraftStore, decodeDraft, draftKey, draftTimeText, encodeDraft, restoreDraft,
} from '../src/draft.js';

/** 一份真的布局（走内核的写入端），用来造真正合法的草稿内容 */
const realLayout = () => room.createLayout({ w: 5, d: 4, h: 2.6 });
const packedOf = (layout) => JSON.parse(scheme.exportScheme(layout));

/** 真的恢复路径：与 `designer.applyServerState` 同一条（内核 `scheme.importScheme`） */
function loader() {
  const box = { layout: null, times: 0, resets: 0 };
  box.apply = (state, format) => {
    const r = scheme.importScheme({ format, state });
    if (!r.ok) return false;
    box.layout = r.layout;
    box.times += 1;
    return true;
  };
  /** 「回到默认那一间房」：与 `designer.resetNewDesign` 同一件事，默认布局走同一个内核入口 */
  box.reset = () => {
    box.resets += 1;
    box.layout = room.createLayout({ w: 8, d: 6, h: 2.8 });
  };
  return box;
}

function memStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    get size() { return map.size; },
    keys: () => [...map.keys()],
  };
}

/* ---------------- 键（F5） ---------------- */

test('草稿键带用户 id，形状是 `spatial.draft.v1.<userId>`', () => {
  // ⚠️ 形状与 test.md 的 F5 字面量（`spatial.draft.7.new`）不同：设计决策记录 §七第1项 定的是
  //    `spatial.draft.v1.<userId>`，而"带方案 id 的草稿键"没有实现 —— 草稿只属于 `/design/new`，
  //    打开 `/design/<id>` 不读草稿（读了就会让本机旧内容盖掉库里那一版）。这里钉住真在用的那个形状。
  assert.equal(DRAFT_VERSION, 1);
  assert.equal(DRAFT_PREFIX, 'spatial.draft.v1.');
  assert.equal(draftKey(7), 'spatial.draft.v1.7');
  assert.equal(draftKey('7'), 'spatial.draft.v1.7');
  assert.equal(draftKey('  7  '), 'spatial.draft.v1.7', '两侧空白不算错');
  assert.notEqual(draftKey(8), draftKey(7), '两个人不能共用一个键');
  assert.ok(draftKey(7).startsWith('spatial.draft.'), '探针按这个前缀找键，前缀是约定的一部分');
  assert.ok(draftKey(7).includes('7'), '键里要有用户 id');
});

test('拿不到用户 id 时回空串（键都没名字，读写一律不许往下走）', () => {
  for (const bad of ['', '   ', null, undefined]) {
    assert.equal(draftKey(bad), '', JSON.stringify(bad) + ' 不该给出键');
  }
});

/* ---------------- 编解码（F6，成对） ---------------- */

test('编解码：走一趟逐字段相同（内容与格式都还在）', () => {
  const packed = packedOf(realLayout());
  const text = encodeDraft(packed.state, packed.format, 1730000000000);
  const back = decodeDraft(text);
  assert.deepEqual(back.state, packed.state);
  assert.equal(back.format, packed.format);
  assert.equal(back.savedAt, 1730000000000);
  assert.equal(JSON.parse(text).v, DRAFT_VERSION, '文本里要带版本号，否则将来换了结构认不出来');
});

test('编解码：读不出来的一律回 null（坏 JSON、缺字段、版本不认识、非对象）', () => {
  const good = encodeDraft({ w: 5, d: 4, h: 2.6 }, scheme.FORMAT, 1);
  assert.ok(decodeDraft(good), '前提：这一份是好的');
  const bad = [
    'not json at all',
    '{',
    'null',
    '[]',
    '"字符串"',
    JSON.stringify({ savedAt: 1, state: {}, format: 'x' }),                      // 缺版本号
    JSON.stringify({ v: 99, savedAt: 1, state: {}, format: 'x' }),               // 版本号不认识
    JSON.stringify({ v: DRAFT_VERSION, state: {}, format: 'x' }),                // 缺时间
    JSON.stringify({ v: DRAFT_VERSION, savedAt: 'x', state: {}, format: 'x' }),  // 时间读不出来
    JSON.stringify({ v: DRAFT_VERSION, savedAt: 1, format: 'x' }),               // 缺 state
    JSON.stringify({ v: DRAFT_VERSION, savedAt: 1, state: [], format: 'x' }),    // state 是数组
    JSON.stringify({ v: DRAFT_VERSION, savedAt: 1, state: 'x', format: 'x' }),   // state 是字符串
    JSON.stringify({ v: DRAFT_VERSION, savedAt: 1, state: {} }),                 // 缺 format
  ];
  for (const t of bad) {
    assert.equal(decodeDraft(t), null, t + ' 该被判为读不出来');
  }
  assert.equal(decodeDraft(''), null);
  assert.equal(decodeDraft(null), null);
  assert.equal(decodeDraft(undefined), null);
});

/* ---------------- 存储读写 ---------------- */

test('写入：没有账号 id 时**当场抛出**（不写到一个没名字的键上）', () => {
  const st = memStorage();
  const store = createDraftStore(st, '');
  assert.equal(store.key, '');
  assert.throws(() => store.write({ w: 5 }, scheme.FORMAT), /没有账号 id/);
  assert.equal(st.size, 0, '抛出了就不该留下任何东西');
  assert.equal(store.read(), null, '没有键就读不到东西');
  store.clear();   // 不抛：清一个不存在的键是"已经达成目标"
  assert.equal(st.size, 0);
});

test('写入与读取：同一个人读得回来，换了人就读不到', () => {
  const st = memStorage();
  const packed = packedOf(realLayout());
  createDraftStore(st, 7).write(packed.state, packed.format, 1730000000000);

  const mine = createDraftStore(st, 7).read();
  assert.equal(mine.format, packed.format);
  assert.equal(mine.savedAt, 1730000000000);
  assert.deepEqual(mine.state, packed.state);
  assert.deepEqual(st.keys(), ['spatial.draft.v1.7']);

  assert.equal(createDraftStore(st, 8).read(), null, '换了账号不许读到别人的草稿');
  assert.equal(st.size, 1, '读别人的草稿不该顺手删掉它');
});

test('清掉：只清自己那一个键', () => {
  const st = memStorage();
  const packed = packedOf(realLayout());
  createDraftStore(st, 7).write(packed.state, packed.format, 1);
  createDraftStore(st, 8).write(packed.state, packed.format, 1);
  createDraftStore(st, 7).clear();
  assert.deepEqual(st.keys(), ['spatial.draft.v1.8']);
  assert.equal(createDraftStore(st, 7).read(), null);
});

/* ---------------- 恢复提示里的时间 ---------------- */

test('恢复提示的时间按**本机时区**显示（拿 UTC 切字符串会差八小时）', () => {
  // 2026-10-16 18:12（本机时区）—— 与 `new Date(...).getHours()` 对得上才叫本机时间
  const local = new Date(2026, 9, 16, 18, 12, 30).getTime();
  assert.equal(draftTimeText(local), '10-16 18:12');
  const d = new Date(local);
  assert.match(draftTimeText(local), /^\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(draftTimeText(local).slice(6, 8), String(d.getHours()).padStart(2, '0'),
    '小时数要与本机时区一致');
  assert.equal(draftTimeText(local).slice(9, 11), String(d.getMinutes()).padStart(2, '0'));
  // 读不出来的时间回空串（界面会说「已恢复上次未保存的改动」，不会出现 1970 年那种数）
  assert.equal(draftTimeText('这不是时间'), '');
  assert.equal(draftTimeText(null), '');
});

/* ---------------- 恢复前的内核校验（F7） ---------------- */

test('恢复：合法草稿过内核校验之后才写进编辑器', () => {
  const st = memStorage();
  const packed = packedOf(realLayout());
  createDraftStore(st, 7).write(packed.state, packed.format, 1730000000000);
  const l = loader();

  const r = restoreDraft(createDraftStore(st, 7), l.apply, l.reset);
  assert.equal(r.restored, true);
  assert.equal(l.times, 1, 'apply 必须被调用一次');
  assert.equal(l.layout.w, 5);
  assert.equal(l.layout.d, 4);
  assert.equal(l.resets, 0, '有草稿就不许把工作区清回默认');
  assert.equal(r.draft.savedAt, 1730000000000);
});

test('恢复：内核校验不过的草稿被丢弃，编辑器不写它，工作区回到默认那一间房', () => {
  const st = memStorage();
  // `w` 为负：这份内容过不了内核（`bad-room`），正是"手改过的本机缓存"那种形状
  const broken = encodeDraft({ w: -3, d: 4, h: 2.6, items: [], walls: [] }, scheme.FORMAT, 1);
  st.setItem(draftKey(7), broken);
  const l = loader();

  const r = restoreDraft(createDraftStore(st, 7), l.apply, l.reset);
  assert.equal(r.restored, false);
  assert.equal(r.reason, 'rejected');
  assert.equal(l.times, 0, '没通过校验就不许写进编辑器');
  assert.equal(l.resets, 1, '没有可用的草稿，工作区就得是默认那一间房');
  assert.equal(l.layout.w, 8);
  assert.equal(l.layout.d, 6);
  assert.equal(st.size, 0, '坏草稿要当场丢掉 —— 留着只会每次打开都失败一次');
});

test('恢复：没有草稿时说清是"空的"，这与"被拒绝"是两件事', () => {
  const st = memStorage();
  const l = loader();
  const r = restoreDraft(createDraftStore(st, 7), l.apply, l.reset);
  assert.equal(r.restored, false);
  assert.equal(r.reason, 'empty');
  assert.equal(l.times, 0);
  assert.equal(l.resets, 1, '「空的」也意味着工作区不该留着上一个人的内容');
});

test('恢复：读不出来的文本等于"没有草稿"（还没到校验那一步，存储不动它）', () => {
  const st = memStorage();
  st.setItem(draftKey(7), '{半份内容');
  const l = loader();
  const r = restoreDraft(createDraftStore(st, 7), l.apply, l.reset);
  assert.equal(r.restored, false);
  assert.equal(r.reason, 'empty', '读不出来的文本等于没有草稿（还没到校验那一步）');
  assert.equal(l.resets, 1, '读不出来也算没有草稿：工作区回默认');
  assert.equal(st.size, 1, '这一步不该动存储 —— 清它的是"读到但校验不过"那一条');
});

/* ---------------- 换账号之后的工作区 ---------------- */

test('换账号之后：当前账号没有草稿时，工作区回到默认那一间房，而且没有恢复提示', () => {
  const st = memStorage();
  // A 在 `/design/new` 上改了东西：这条草稿按账号分开存着，退出登录不清它
  const a = packedOf(realLayout());                        // 5 × 4 × 2.6
  createDraftStore(st, 7).write(a.state, a.format, 1730000000000);
  const l = loader();
  l.layout = room.createLayout({ w: 5, d: 4, h: 2.6 });    // 编辑器此刻还是 A 那一间房

  // 退出登录 → B 登录 → 进 `/design/new`：同一篇文档，内存里那份布局不会自己回到默认
  const r = restoreDraft(createDraftStore(st, 8), l.apply, l.reset);

  assert.equal(r.restored, false);
  assert.equal(r.reason, 'empty');
  assert.equal(r.draft, undefined, '什么都没恢复，界面也就没有「已恢复上次未保存的改动」这句');
  assert.equal(l.times, 0);
  assert.equal(l.resets, 1, '没有草稿就必须回到默认那一间房');
  assert.equal(l.layout.w, 8, '与整篇刷新之后进 `/design/new` 看到的是同一间');
  assert.equal(l.layout.d, 6);
  assert.equal(l.layout.h, 2.8);
  assert.equal(l.layout.items.length, 0, '默认那一间房里没有 A 摆过的东西');
  assert.equal(st.size, 1, 'A 的草稿原封不动 —— 退出登录不清草稿这条设计不变');
  assert.deepEqual(st.keys(), [draftKey(7)]);
});

test('换账号之后：B 自己那份草稿照旧恢复，并给出提示语要用的时间', () => {
  const st = memStorage();
  const b = packedOf(room.createLayout({ w: 9, d: 7, h: 3 }));
  createDraftStore(st, 8).write(b.state, b.format, 1730000600000);
  const l = loader();
  l.layout = room.createLayout({ w: 8, d: 6, h: 2.8 });    // 进门前是默认那一间

  const r = restoreDraft(createDraftStore(st, 8), l.apply, l.reset);

  assert.equal(r.restored, true);
  assert.equal(r.draft.savedAt, 1730000600000, '提示语里那个时间来自草稿自己');
  assert.equal(l.times, 1);
  assert.equal(l.resets, 0, '有草稿就不许把工作区清回默认');
  assert.equal(l.layout.w, 9);
  assert.equal(l.layout.d, 7);
});

test('少给 reset 就地抛出：忘掉「回默认」这一支正是这次的缺口', () => {
  const st = memStorage();
  assert.throws(() => restoreDraft(createDraftStore(st, 7), () => true), /reset/);
});
