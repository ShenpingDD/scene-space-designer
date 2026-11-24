/**
 * view.test.js —— 分诊数字与筛选的判据。
 *
 * 钉两类错：**数字算错**（管理员据此安排今天做什么）与**筛选静默吞行**（以为产品就这些）。
 * 夹具照真数据写：demo-freezer-dual 同时有「尺寸未对账」+「非 1:1」+「缺缩略图」，
 * 另外三款只有「缺缩略图」—— 这就是真实库里的样子。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FILTERS, summarize, visible, storeLabel,
  STATUS, statusLabel, nextStatus, statusActionLabel, statusConfirmLines,
} from '../src/admin/view.js';

const badge = (level, text) => ({ level, text, why: '…' });

const ctScanner = { recipeId: 'demo-ct-scanner', status: 'active', badges: [badge('warn', '缺缩略图')] };
const freezerDual = {
  recipeId: 'demo-freezer-dual', status: 'active',
  badges: [badge('warn', '缺缩略图'), badge('warn', '尺寸未对账'), badge('warn', '非 1:1')],
};
const freezerUpright = { recipeId: 'demo-freezer-upright', status: 'active', badges: [badge('warn', '缺缩略图'), badge('warn', '非 1:1')] };
const stopped = { recipeId: 'old1', status: 'disabled', badges: [badge('off', '已停用')] };
const broken = { recipeId: 'x1', status: 'active', badges: [badge('bad', '无模型')] };

const LIST = [ctScanner, freezerDual, freezerUpright, stopped, broken];

test('汇总以「产品条数」为单位，不是角标个数', () => {
  const s = summarize(LIST);
  assert.equal(s.total, 5);
  assert.equal(s.bad, 1, '只有 x1 有 bad 角标');
  assert.equal(s.warn, 3, 'demo-ct-scanner/demo-freezer-dual/demo-freezer-upright 三条有 warn —— 不是 6 个角标');
  assert.equal(s.off, 1);
  assert.equal(s.noModel, 1);
});

test('空值 / 残缺数据不许抛异常、不许出 NaN', () => {
  for (const v of [null, undefined, [], 'x', [null, {}]]) {
    const s = summarize(v);
    assert.equal(typeof s.total, 'number');
    assert.ok(Number.isFinite(s.total));
    assert.ok(Number.isFinite(s.bad) && Number.isFinite(s.warn));
  }
});

test('筛选不许丢行：all 档必须等于总数', () => {
  assert.equal(visible(LIST, FILTERS.ALL).length, summarize(LIST).total);
  assert.equal(visible(LIST).length, 5, '不传档位等于 all');
});

test('各档位筛出的条数与汇总一致（两条路必须算出同一个数）', () => {
  assert.equal(visible(LIST, FILTERS.BAD).length, summarize(LIST).bad);
  assert.equal(visible(LIST, FILTERS.WARN).length, summarize(LIST).warn);
  assert.equal(visible(LIST, FILTERS.OFF).length, summarize(LIST).off);
});

test('筛出来的是「有该级角标的产品」，不是去掉角标的产品', () => {
  const w = visible(LIST, FILTERS.WARN);
  assert.deepEqual(w.map((p) => p.recipeId), ['demo-ct-scanner', 'demo-freezer-dual', 'demo-freezer-upright']);
  assert.equal(w[1].badges.length, 3, '筛出来的产品要保留它全部角标（筛的是产品，不是角标）');
});

test('数据来源档位：memory 档不许说成「没有产品」', () => {
  assert.equal(storeLabel('jdbc'), '数据库');
  assert.equal(storeLabel('memory'), '无数据库档');
  assert.notEqual(storeLabel('memory'), '数据库');
});
// ── 停用 / 启用（批 3 · req-1）───────────────────────────────────────────────
//
// 决策③「产品只停用不删除」的**唯一没承接方的一条**：读侧全就绪（目录查 status='active'、
// 列表有"已停用"档位与角标），却没有任何地方能写 disabled。这里钉住的是
// **界面必须说清的后果**，因为说漏一句就会造成一种真实的误解。

const pActive = { id: 7, name: 'DEMO-FZ-040', status: 'active' };
const pOff = { id: 8, name: 'DEMO-FZ-25U 系列', status: 'disabled' };
const pDraft = { id: 9, name: '新导入的一款', status: 'draft' };

test('状态文字：停用/启用/未就绪分得清，认不出的值不猜', () => {
  assert.equal(statusLabel('active'), '已启用');
  assert.equal(statusLabel('disabled'), '已停用');
  assert.equal(statusLabel('draft'), '未就绪（LOD 没跑完）');
  assert.equal(statusLabel(''), '');
  assert.equal(statusLabel(null), '', '缺字段不补：认不出就什么都不说');
  assert.notEqual(statusLabel('draft'), '已停用', 'draft 不是停用 —— 混起来会让"停用"变成万能解释');
});

test('动作方向：停用 ↔ 启用，按钮说出它会做什么', () => {
  assert.equal(nextStatus('active'), 'disabled');
  assert.equal(nextStatus('disabled'), 'active');
  assert.equal(nextStatus('draft'), 'disabled', '未就绪的下一步是停用（它本来就没在前台）');
  assert.equal(statusActionLabel('active'), '停用');
  assert.equal(statusActionLabel('disabled'), '启用');
});

test('确认文案：两个方向的后果都要说，一句都不能少', () => {
  const off = statusConfirmLines(pActive).join(' | ');
  assert.ok(off.includes('前台型号卡与目录'), '要说清前台会看不到');
  assert.ok(off.includes('照常打开'), '要说清已存方案与分享链接不受影响');
  assert.ok(off.includes('一条都不改'), '要说清内容没被动');
  const on = statusConfirmLines(pOff).join(' | ');
  assert.ok(on.includes('重新出现在前台目录'), '启用要说清会重新出现');
  assert.ok(on.includes('不受影响'), '启用也要说清方案/链接不受影响');
});

test('未就绪（draft）直接启用要给警告 —— 那不是"恢复正常"，是把没验完的东西放出去', () => {
  const lines = statusConfirmLines(pDraft).join(' | ');
  assert.ok(lines.includes('未就绪'), '要把它的真实状态说出来');
  assert.ok(lines.includes('没有产物文件'), '要说清后果：前台会拿到一份没有产物的模型');
});
