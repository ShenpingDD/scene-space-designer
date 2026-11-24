import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEV_ONLY_WORDS, devOnlyHits, barText, presentNote, BANNED_ON_CLIENT_PAGE,
  viewHint, walkNote, shareErrorTitle, shareErrorPage, isCoarsePointer, stickVector, SHARE_ERROR_NEXT,
} from '../src/present.js';

/**
 * present.test.js —— 面客模式的话术（设计决策记录 §4.7 / §12.4）
 *
 * 这一层钉的全是"说错了也没人报错"的事：
 *   ① **不许出现给开发者的话**（`cd tools/models && npm run extract` 那类）——
 *      客户看到它只能发愣，而界面上也不会有人拦；
 *   ② 「多少台」读不到时不许写 0（0 台是关于方案的一句话，读不到是关于这次读取的一句话）；
 *   ③ 「看到的是当前内容」必须**由数据带着走**，不许写死（写死的那份迟早与库里的说法漂开）；
 *   ④ 四种状态（模型没做好 / 没加载出来 / 空方案 / 正在载入）不许互相冒充；
 *   ⑤ 触摸屏上的操作提示必须说清**怎么走**（摇杆）与**怎么转头**（拖画面）——
 *      并且**不许**教他按 WASD（那个屏幕没有键盘）。
 *
 * ⚠️ 判据自己也会假绿（C25）：所以第 1 条**同时断言扫描器能抓到一个真的坏句子** ——
 *    不然把 `DEV_ONLY_WORDS` 清空，所有断言照样绿。
 */

test('⭐ 面客模式的每一句话里都不许有"给开发者的话"（并把扫描器本身也验一遍）', () => {
  const texts = [
    barText({ name: '检验科 3 号间', count: 3 }).name,
    barText({ name: '检验科 3 号间', count: 3 }).countText,
    barText({ name: '检验科 3 号间', count: 3 }).badge,
    barText({}).name,
    barText({}).countText,
    presentNote({ items: 3, meshes: 0, errors: 1, missingAssets: 0 }).text,
    presentNote({ items: 3, meshes: 0, errors: 0, missingAssets: 2 }).text,
    presentNote({ items: 0 }).text,
    presentNote({ items: 4, meshes: 1 }).text,
    viewHint('orbit', { coarse: false }),
    viewHint('orbit', { coarse: true }),
    viewHint('walk', { coarse: false }),
    viewHint('walk', { coarse: true }),
    walkNote(true).text,
    walkNote(false) ? walkNote(false).text : '走得很顺',
    shareErrorTitle('share-expired'),
    shareErrorTitle('share-revoked'),
    shareErrorTitle('not-found'),
    SHARE_ERROR_NEXT,
  ];
  // 双向：扫描器必须真能抓到坏句子（拿 View3D 里那句真话当靶子）
  const bad = '模型资产没就绪：先跑 npm run assets，再看 node tools/ 的输出';
  assert.ok(devOnlyHits(bad).length >= 2,
    '扫描器抓不到已知的坏句子，说明判据自己假绿了：' + JSON.stringify(devOnlyHits(bad)));
  assert.deepEqual(devOnlyHits('刷新试试'), [], '干净句子不该被误报');
  for (const t of texts) {
    assert.deepEqual(devOnlyHits(t), [], `面客模式不许出现开发者的话：${t}`);
  }
  assert.ok(DEV_ONLY_WORDS.length >= 4, '只给开发者看的词表不该是空的');
});

test('信息条三件事：这是什么 / 多少台 / 只读 —— 读不到台数不许写 0', () => {
  const a = barText({ name: '检验科 3 号间', count: 12 });
  assert.equal(a.name, '检验科 3 号间');
  assert.equal(a.countText, '12 台设备');
  assert.equal(a.badge, '只读');
  assert.equal(barText({ name: '   ' }).name, '（没有名字）', '空白名字要说"没有名字"，不能留空');
  // 0 与"读不到"是两句话，不许互相冒充
  assert.equal(barText({ count: 0 }).countText, '0 台设备');
  assert.equal(barText({}).countText, '— 台设备');
  assert.notEqual(barText({}).countText, barText({ count: 0 }).countText);
  assert.equal(barText({ count: 'x' }).countText, '— 台设备', '不是数就不冒充 0');
});

test('⭐ 只读那段说明**整块删掉**了（2026-10-08 用户拍板）—— 而且不许偷偷回来', () => {
  // 用户原话：预览页上那一段"有点多余，可以去掉"。删是一件事，**不许回来**是另一件：
  // 这些字会从模板、从拷贝的旧代码、从"多加一句没坏处"的善意里长回来 —— 所以要能机器判。
  const texts = [
    ...BANNED_ON_CLIENT_PAGE,
    barText({ name: 'x', count: 1 }).badge,
    viewHint('orbit', { coarse: false }), viewHint('walk', { coarse: true }),
  ];
  const hits = texts.filter((t) => BANNED_ON_CLIENT_PAGE.some((b) => String(t).includes(b))
    && !BANNED_ON_CLIENT_PAGE.includes(t));
  assert.deepEqual(hits, [], '被删掉的那几句话又出现在了界面文案里：' + JSON.stringify(hits));
  // 扫描器自检（C25）：拿真句子当靶子，证明它抓得到
  const probe = BANNED_ON_CLIENT_PAGE[0] + '看着玩';
  assert.ok(BANNED_ON_CLIENT_PAGE.some((b) => probe.includes(b)), '这个扫描器自己得能抓到东西');
  // 「只读」这件事**没丢**：它在信息条那个小标签上
  assert.equal(barText({ name: 'x', count: 1 }).badge, '只读');
});

test('⭐ 撤销 / 过期 = 全屏一句话；口令对不上 = 标题 + 一行（双向，不许互相冒充）', () => {
  for (const r of ['share-revoked', 'share-expired']) {
    const p = shareErrorPage(r);
    assert.equal(p.bare, true, r + ' 该是一句话那条路');
    assert.deepEqual(p.lines, [], r + ' 不许再有下一步小字');
    assert.equal(p.showDetail, false, r + ' 不许再摆服务端那句话');
    assert.ok(p.title.length > 4 && !p.title.includes('读不到'), '标题要说清是哪种不能用：' + p.title);
  }
  // 口令对不上：客户多半是链接被截断/敲错了 —— 什么都不说他会以为网站坏了
  const nf = shareErrorPage('not-found');
  assert.equal(nf.bare, false);
  assert.deepEqual(nf.lines, [SHARE_ERROR_NEXT]);
  assert.equal(nf.showDetail, false, '这一种有分类标题，服务端那句话不用再摆一遍');
  // 没料到的原因：服务端那句话是**唯一线索**，必须留着
  const un = shareErrorPage('boom');
  assert.equal(un.showDetail, true, '不知道哪种错时不许把唯一的线索吞掉');
  // 双向：撤销与过期的话**不一样**（两种"不能用"要说两句），而且都不是"读不到"
  assert.notEqual(shareErrorPage('share-revoked').title, shareErrorPage('share-expired').title);
  assert.notEqual(shareErrorPage('share-revoked').bare, shareErrorPage('not-found').bare);
  assert.equal(shareErrorTitle('share-revoked').includes('撤销'), true);
});

test('⭐ 画布提示四种状态不许互相冒充；一切正常时**不编一句话**', () => {
  const missing = presentNote({ items: 5, meshes: 0, errors: 2, missingAssets: 2 });
  assert.equal(missing.kind, 'bad');
  assert.ok(missing.text.includes('还没做好'), missing.text);
  assert.ok(missing.text.includes('联系'), '要给出下一步找谁：' + missing.text);

  const failed = presentNote({ items: 5, meshes: 4, errors: 1, missingAssets: 0 });
  assert.equal(failed.kind, 'bad');
  assert.ok(failed.text.includes('刷新'), '能给客户的下一步要先给：' + failed.text);
  assert.notEqual(failed.text, missing.text, '两种坏法要两句不同的话');

  // 优先级：模型没做好（终态）> 没加载出来 > 空方案 > 正在载入
  assert.equal(presentNote({ items: 5, meshes: 0, errors: 3, missingAssets: 2 }).text, missing.text,
    '同一台数下，missing 那句必须压过 errors 那句（不然就是被后者盖住了）');

  const empty = presentNote({ items: 0, meshes: 0, errors: 0 });
  assert.equal(empty.kind, 'info');
  assert.ok(empty.text.includes('还没有设备'), empty.text);
  assert.ok(!empty.text.includes('放入'), '只读页不许劝客户"去放一台"（他放不了）：' + empty.text);

  const loading = presentNote({ items: 4, meshes: 1, errors: 0 });
  assert.equal(loading.kind, 'info');
  assert.ok(loading.text.includes('1/4'), '要说清进度：' + loading.text);

  assert.equal(presentNote({ items: 4, meshes: 4, errors: 0 }), null, '一切正常就什么都不说');
  assert.equal(presentNote({}), null, '空输入 = 没什么可说（不是"空方案"—— 那时根本没有 items 的概念）');
  assert.notEqual(presentNote({ items: 1, meshes: 1, errors: 0 }), presentNote({ items: 1, meshes: 0, errors: 0 }));
});

test('操作提示：两种视角 × 两种输入 = 四句不同的话；触摸屏要说清怎么走怎么转头', () => {
  const four = [
    viewHint('orbit', { coarse: false }),
    viewHint('orbit', { coarse: true }),
    viewHint('walk', { coarse: false }),
    viewHint('walk', { coarse: true }),
  ];
  assert.equal(new Set(four).size, 4, '四种组合要给四句不同的话：' + JSON.stringify(four));
  assert.ok(four[0].includes('滚轮'), '桌面鸟瞰：鼠标的说法');
  assert.ok(four[1].includes('单指') && four[1].includes('双指'), '触摸鸟瞰：手指的说法');
  assert.ok(four[2].includes('W A S D'), '桌面第一人称：键盘走动');
  assert.ok(!four[3].includes('W A S D'), '触摸第一人称不许教他按 WASD（他没有键盘）：' + four[3]);
  assert.ok(four[3].includes('摇杆'), '触摸第一人称的出路 = 左下摇杆（批 C 接上了，就不能再只说"做不到"）：' + four[3]);
  assert.ok(four[3].includes('拖'), '能给客户的出路要留着（转头还能做）：' + four[3]);
});

/**
 * 摇杆换算（批 C）。
 *
 * 这里最容易错的是一条**符号**（推"上"到底是前还是后）：错了不报错、界面也能跑，
 * 客户只会觉得"摇杆反的"，而手感说不清是哪条轴（与 `walkbasis.js` 同一个教训）。
 * 所以四个方向**各占一条**，并且都是双向的（左与右都断言，不只断言一个）。
 */
test('⭐ 摇杆：推上是向前（屏幕 y 向下），推多少走多快，圈外夹住，死区里不动', () => {
  const R = 52;
  // ① 四个方向
  const up = stickVector(0, -R, R);
  assert.ok(up.fwd > 0.99, '推"上"必须向前（fwd 为正）：' + JSON.stringify(up));
  assert.ok(Math.abs(up.right) < 1e-9, '推"上"不该横向动：' + JSON.stringify(up));
  const down = stickVector(0, R, R);
  assert.ok(down.fwd < -0.99, '推"下"向后：' + JSON.stringify(down));
  const right = stickVector(R, 0, R);
  assert.ok(right.right > 0.99, '推"右"向右：' + JSON.stringify(right));
  const left = stickVector(-R, 0, R);
  assert.ok(left.right < -0.99, '推"左"向左（双向：不能只验右）：' + JSON.stringify(left));
  assert.ok(Math.abs(right.fwd) < 1e-9 && Math.abs(left.fwd) < 1e-9, '左右推不该前后动');

  // ② 推一半 = 走一半（线性，不是"到某个阈值才起步"的开关）
  const half = stickVector(0, -R / 2, R);
  assert.ok(Math.abs(half.fwd - 0.5) < 0.01, '推一半应走一半：' + JSON.stringify(half));
  assert.ok(half.mag > 0 && half.mag < 0.6, 'mag 也要跟着小：' + JSON.stringify(half));

  // ③ 圈外夹住：拖得再远也不许更快（否则指尖一滑就飞了）
  const far = stickVector(0, -R * 4, R);
  assert.ok(Math.abs(far.fwd - 1) < 1e-9, '圈外要夹到 1：' + JSON.stringify(far));
  assert.equal(far.clustered, true, '要说清"已经夹住了"（界面可选地给个手感反馈）');
  assert.equal(half.clustered, false);
  assert.equal(stickVector(0, -R, R).clustered, false, '正好在圈上不算夹');

  // ④ 死区：手搭上去不算推（不然会慢慢飘）
  const rest = stickVector(2, -3, R);
  assert.deepEqual({ f: rest.fwd, r: rest.right, m: rest.mag }, { f: 0, r: 0, m: 0 },
    '死区之内必须一动不动：' + JSON.stringify(rest));
  assert.ok(stickVector(0, -9, R).mag > 0, '越过死区就该走（死区不能大到"推了没反应"）');

  // ⑤ 脏输入不许算出 NaN（手指刚按下、坐标还没来）
  for (const v of [stickVector(undefined, undefined, R), stickVector(NaN, NaN, R), stickVector(0, 0, R)]) {
    assert.ok(Number.isFinite(v.fwd) && Number.isFinite(v.right) && Number.isFinite(v.mag),
      '脏输入不能算出 NaN：' + JSON.stringify(v));
    assert.equal(v.fwd, 0);
  }
});

test('第一人称「过不去」要说出来（FIX-17：嵌入几何体时界面不许静默）', () => {
  assert.equal(walkNote(false), null, '走得动就什么都不说');
  assert.equal(walkNote(undefined), null);
  assert.equal(walkNote(0), null);
  const w = walkNote(true);
  assert.equal(w.kind, 'bad');
  assert.ok(w.text.includes('过不去'), w.text);
  assert.ok(/方向|绕/.test(w.text), '要给下一步（换个方向），不是只说"碰撞了"：' + w.text);
  assert.ok(!/stuck|collision/i.test(w.text), '不许把内核的字段名漏给客户：' + w.text);
});

test('链接不能用：三种原因三句话（下一步动作不同，不许糊成一句）', () => {
  const t = ['share-expired', 'share-revoked', 'not-found', 'error'].map(shareErrorTitle);
  assert.equal(new Set(t).size, 4, '四行必须互不相同：' + JSON.stringify(t));
  assert.ok(t[0].includes('过期'));
  assert.ok(t[1].includes('撤销'));
  assert.ok(t[2].includes('口令'));
  assert.ok(SHARE_ERROR_NEXT.includes('找'), '要给客户一条能走的路：' + SHARE_ERROR_NEXT);
});

test('触摸屏判断：问的是「粗指针 + 没有悬停」；问不了就当桌面（不瞎猜）', () => {
  const mk = (matches) => ({ matchMedia: () => ({ matches }) });
  assert.equal(isCoarsePointer(mk(true)), true);
  assert.equal(isCoarsePointer(mk(false)), false);
  assert.equal(isCoarsePointer({}), false, '没有 matchMedia 的环境（node）不许抛错');
  assert.equal(isCoarsePointer(undefined), false);
  const boom = { matchMedia: () => { throw new Error('nope'); } };
  assert.equal(isCoarsePointer(boom), false, 'matchMedia 抛错也不许把页面带崩');
});