/**
 * catalog.test.js —— 目录适配层的断言（不需要浏览器、不需要后端）
 *
 * 最值钱的两条：`noteLevel` / `doorPart` 这两个**派生字段**，拿**本地资产当标准答案**
 * 逐款比对 4/4。本地那一份是手写的、独立来源 —— 所以验的是真东西，不是拿派生验派生。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptServerProduct, catalogState, doorPartOf, getProduct, loadCatalog, noteLevelOf,
} from '../src/catalog.js';
import { CATALOG as STATIC } from '../src/data/catalog.js';
import { DOORS_MEASURED } from '../src/data/doors.measured.js';

test('noteLevel 4/4：尺寸可信度等级就是 sizeNote 的展示分类', () => {
  let checked = 0;
  for (const p of STATIC) {
    assert.equal(noteLevelOf(p.sizeNote), p.noteLevel, p.id + ' 的 noteLevel');
    checked += 1;
  }
  assert.equal(checked, STATIC.length);
});

test('doorPart 取服务端那一列 —— 几何推导是错的，这就是它必须是一列的原因', () => {
  // 一门一扇、绕 y 轴 → 兜底推导给 'single'；但产品本身是「双门」：推导在这里**就是错的**。
  const doors = [{ node: 'upper_door', axis: 'y', openAngleDeg: 106 }];
  assert.equal(doorPartOf(doors), 'single', '几何推导在这里给出的是**错的**答案');
  assert.equal(
    adaptServerProduct({ id: 'demo-freezer-dual', w: 0.99, d: 0.87, h: 1.98, doorPart: 'double', doors, notes: {} }).doorPart,
    'double', '列在就必须听列的',
  );
  // 列缺失（服务端没这一列）时才退回推导 —— 这条路可能是错的，所以服务端发现缺列要打 WARN（不许安静）
  assert.equal(adaptServerProduct({ id: 'demo-freezer-dual', w: 0.99, d: 0.87, h: 1.98, doors, notes: {} }).doorPart, 'single');
  // 列**显式为 null** = 「这个型号没有门」（演示机 demo-ct-scanner 就是这种）：不许推成 single 编一个门出来
  assert.equal(adaptServerProduct({ id: 'demo-ct-scanner', w: 3.045, d: 2.47, h: 2.138, doorPart: null, doors: [], notes: {} }).doorPart, null);
});

test('其余五款：门部件名的权威来源是手写目录，透传后逐款一致', () => {
  let checked = 0;
  // demo-ct-scanner 的声明门是**没有门**（doorPart=null），它归上面那条用例管
  for (const p of STATIC.filter((x) => x.doorPart)) {
    const got = adaptServerProduct({ ...p, doorPart: p.doorPart, notes: {} }).doorPart;
    assert.equal(got, p.doorPart, p.id);
    checked += 1;
  }
  assert.equal(checked, 5, '不许空转通过（五款带门的演示机型；demo-ct-scanner 无门，归上一条）');
});

test('适配层：数据库列名 → 界面字段（含声明门与实测门分开）', () => {
  const p = adaptServerProduct({
    id: 'demo-freezer-dual', dbId: 2, model: 'DEMO-FZ-040', name: '双温双控低温保存箱',
    w: 0.99, d: 0.8712, h: 1.98, color: '#286eac', origin: '官网外观重建',
    sizeNote: '演示比例 · 非产品尺寸', desc: '介绍', sourceUrl: null,
    file: 'assets/optimized/DEMO-FZ-040.lod0.glb', modelMd5: 'abc', thumbUrl: null,
    envelopeMode: 'fit', bboxMm: { w: 525.5, d: 517, h: 990 },
    doors: [{ node: 'upper_door', axis: 'y', openAngleDeg: 106 }],
    recipeDoors: [{ node: 'upper_door', axis: 'y', openAngleRad: 1.85 }],
    notes: { facts: [['有效容积', '510 L']], features: [['独立双控', '上下箱体独立']] },
  });
  assert.equal(p.id, 'demo-freezer-dual');
  assert.equal(p.model, 'DEMO-FZ-040');
  assert.equal(p.noteLevel, 'bad');
  assert.deepEqual(p.facts, [['有效容积', '510 L']]);
  assert.deepEqual(p.features, [['独立双控', '上下箱体独立']]);
  assert.deepEqual(p.hinges, [{ name: 'upper_door', axis: 'y', openAngle: 1.85 }]);
  assert.equal(p.assetFile, 'assets/optimized/DEMO-FZ-040.lod0.glb');
  assert.equal(p.thumbUrl, null, '缩略图没生成就不给路径');
  assert.equal(p.bboxMm.w, 525.5, '实测包围盒原样留着（校准口径）');
});

test('加载成功：目录整体换成服务端的，查找跟着走', async () => {
  const res = await loadCatalog(async () => ({
    products: [{
      id: 'x1', model: 'X-1', name: '测试箱', w: 1.2, d: 0.8, h: 1.5, color: '#123456',
      sizeNote: '模型测量 · 待核实', notes: { facts: [], features: [] },
      doors: [{ node: 'd', axis: 'y', openAngleDeg: 100 }], recipeDoors: [],
    }],
  }));
  assert.equal(res.ok, true);
  assert.equal(catalogState.source, 'server');
  assert.equal(catalogState.rows.length, 1);
  assert.equal(getProduct('x1').w, 1.2);
  assert.equal(getProduct('demo-ct-scanner'), undefined, '旧的本地型号在服务端目录里不存在时，查找也不该再返回它');
});

test('加载失败：退回本地资产，而且行也是真的换回来了（不是只改标签）', async () => {
  const res = await loadCatalog(async () => { throw Object.assign(new Error('连不上后端'), { reason: 'backend-down' }); });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'backend-down');
  assert.equal(catalogState.source, 'static');
  assert.equal(catalogState.rows.length, STATIC.length);
  assert.ok(getProduct('demo-ct-scanner'), '本地资产必须仍然可用 —— 后端没起也要能干活');
  assert.equal(catalogState.error, 'backend-down');
});

test('服务端给了空目录：当失败处理，不许把空目录当成"新事实"', async () => {
  const res = await loadCatalog(async () => ({ products: [] }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'catalog-empty');
  assert.ok(catalogState.rows.length > 0, '空目录 = 后端有问题，不是"没有型号"');
});

test('残缺的服务端条目被跳过并计数（不许把没有占地的型号塞进目录）', async () => {
  const res = await loadCatalog(async () => ({
    products: [
      { id: 'ok', model: 'OK', name: '好的', w: 1, d: 1, h: 1, color: '#000', notes: {} },
      { id: 'nope', model: 'BAD', name: '缺尺寸', w: null, d: 1, h: 1, notes: {} },
    ],
  }));
  assert.equal(res.ok, true);
  assert.equal(res.count, 1);
  assert.equal(res.skipped, 1);
});

/* ---------------- 自动重读（task-75：同页看见新产品）----------------
 *
 * 三条判据：① focus/可见性触发**要节流**（≥5s，按"尝试"算）；② 手动刷新**跳过**节流；
 * ③ 目录里**不许出现草稿**（未上架产品），否则设计端会看到一款点不进去的产品。
 */
import { canOpenDetail, refreshCatalog, startCatalogAutoRefresh, CATALOG_POLL_MS, REFRESH_THROTTLE_MS } from '../src/catalog.js';

test('节流：5 秒内的第二次自动重读被挡下，且不真的发请求', async () => {
  let calls = 0;
  const fetchOnce = async () => { calls += 1; return { products: [{ id: 'a1', model: 'A', name: '甲', w: 1, d: 1, h: 1, notes: {} }] }; };
  const t0 = 1_000_000;
  const first = await refreshCatalog({ fetch: fetchOnce, now: t0, reason: 'focus' });
  assert.equal(first.ok, true);
  assert.equal(calls, 1);
  // 同一毫秒再来一次 → 被节流（不发请求）
  const second = await refreshCatalog({ now: t0 + 1000, reason: 'visible' });
  assert.equal(second.skipped, 'throttled');
  assert.equal(calls, 1, '被节流挡下就不该真的打后端');
  // 过 5 秒 → 放行
  const third = await refreshCatalog({ now: t0 + REFRESH_THROTTLE_MS + 1, reason: 'focus' });
  assert.equal(third.ok, true);
  assert.equal(calls, 2);
});

test('手动刷新（force）：跳过节流，点一次就真的去问一次', async () => {
  let calls = 0;
  await refreshCatalog({ fetch: async () => { calls += 1; return { products: [{ id: 'b1', w: 1, d: 1, h: 1, notes: {} }] }; }, now: 2_000_000 });
  const before = calls;
  const r = await refreshCatalog({ force: true, now: 2_000_500 });
  assert.equal(r.ok, true);
  assert.equal(calls, before + 1);
});

test('节流按"尝试"算：失败之后 5 秒内不会每次 focus 都重连一遍', async () => {
  let calls = 0;
  const boom = async () => { calls += 1; throw Object.assign(new Error('连不上'), { reason: 'backend-down' }); };
  await refreshCatalog({ fetch: boom, force: true, now: 3_000_000 });
  assert.equal(calls, 1);
  const r = await refreshCatalog({ now: 3_000_100 });
  assert.equal(r.skipped, 'throttled');
  assert.equal(calls, 1, '失败也要占住节流窗口，否则后端挂着时会被每次切窗口刷一遍');
});

test('目录里只收 active：草稿（未上架）不许进来', async () => {
  const res = await loadCatalog(async () => ({
    products: [
      { id: 'live', model: 'L', name: '已上架', w: 1, d: 1, h: 1, notes: {}, status: 'active', hasDetail: true },
      { id: 'draft', model: 'D', name: '草稿', w: 1, d: 1, h: 1, notes: {}, status: 'draft' },
    ],
  }));
  assert.equal(res.ok, true);
  assert.equal(res.drafts, 1, '被挡下的草稿数要报出来');
  assert.ok(getProduct('live'));
  assert.equal(getProduct('draft'), undefined, '设计端不该看见还没上架的产品');
  assert.equal(getProduct('live').hasDetail, true, '详情入口判据来自服务端');
});

test('服务端没给 hasDetail（jar 还没上线这个字段）= 不给入口：前端不替后端猜', async () => {
  await loadCatalog(async () => ({ products: [{ id: 'nodetail', model: 'N', name: '暂无详情', w: 1, d: 1, h: 1, notes: {}, desc: '有简介' }] }));
  const p = getProduct('nodetail');
  assert.equal(p.hasDetail, false, 'undefined 要落成 false，不能留空让界面自己推');
  assert.equal(canOpenDetail(p), false, '服务端没说是 true 就不该有入口');
  assert.equal(p.hotspotCount, 0);
});

test('canOpenDetail：服务端说了算；本地资产（没有该字段）按同一条口径兜底', () => {
  assert.equal(canOpenDetail({ hasDetail: false, desc: '有简介' }), false, '服务端 false 就是 false');
  assert.equal(canOpenDetail({ hasDetail: true }), true);
  assert.equal(canOpenDetail({ desc: '产品简介' }), true, '本地资产：有简介 → 有得看');
  assert.equal(canOpenDetail({ desc: '', hotspotCount: 0 }), false);
  assert.equal(canOpenDetail(null), false);
});

test('自动重读的监听：focus / visibilitychange / 前台定时 三路都挂上，取消时都摘掉（假 window）', () => {
  const added = [];
  const removed = [];
  let intervalFn = null;
  let cleared = 0;
  const win = {
    addEventListener: (k) => added.push(k),
    removeEventListener: (k) => removed.push(k),
    setInterval: (fn, ms) => { intervalFn = fn; assert.equal(ms, CATALOG_POLL_MS, '默认按 5s 轮询'); return 7; },
    clearInterval: (id) => { cleared += 1; assert.equal(id, 7); },
    document: { visibilityState: 'visible' },
  };
  const stop = startCatalogAutoRefresh(win);
  assert.deepEqual(added.sort(), ['focus', 'visibilitychange']);
  assert.equal(typeof intervalFn, 'function', '前台必须有定时重读（QA 就在同页等新品）');
  stop();
  assert.deepEqual(removed.sort(), ['focus', 'visibilitychange']);
  assert.equal(cleared, 1, '取消时要清掉定时器，否则关掉页面/切走还在跑');
  // 没有 window（node 里/服务端渲染）时给一个空操作，不抛
  assert.equal(typeof startCatalogAutoRefresh(null), 'function');
});

test('前台定时：可见时触发一次重读；hidden 时跳过（后台标签页不烧请求）', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return { products: [{ id: 'poll1', w: 1, d: 1, h: 1, notes: {} }] }; };
  let intervalFn = null;
  const win = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: (fn) => { intervalFn = fn; return 1; },
    clearInterval: () => {},
    document: { visibilityState: 'visible' },
  };
  // 先把取数方式登记进去（生产里是 main.js 启动时 loadCatalog(api.catalog)）
  await loadCatalog(fetcher);
  const before = calls;
  const stop = startCatalogAutoRefresh(win, { intervalMs: CATALOG_POLL_MS });
  // 定时回调是**同步触发** refreshCatalog（内部异步），等一轮微任务/宏任务再数
  intervalFn();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, before + 1, '可见时定时器要真的去取一次');

  // hidden：同样的回调不该发请求
  const hiddenCalls = calls;
  win.document.visibilityState = 'hidden';
  intervalFn();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, hiddenCalls, 'hidden 时不许发请求');
  stop();
});

test('重读失败：旧目录必须留着（拿不到新目录 ≠ 目录变空）', async () => {
  const okFetch = async () => ({ products: [{ id: 'keep1', w: 1, d: 1, h: 1, notes: {} }] });
  await loadCatalog(okFetch);
  assert.ok(getProduct('keep1'));
  const r = await refreshCatalog({
    force: true, now: 9_000_000,
    fetch: async () => { throw Object.assign(new Error('连不上'), { reason: 'backend-down' }); },
  });
  assert.equal(r.ok, false);
  assert.equal(catalogState.source, 'static', '失败按既有规矩退回本地资产');
  assert.ok(getProduct('keep1') || getProduct('demo-ct-scanner'), '目录不能变成空的');
  assert.equal(catalogState.error, 'backend-down');
});
