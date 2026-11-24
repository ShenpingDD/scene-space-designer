/**
 * params.test.js —— 规则参数表
 *
 * 这张测试的意义超出"参数类"本身：参数表是**业务语义的入口**。
 * 所以这里要证明三件事：
 *   ① 默认值就是文档里写的那些数（改默认值必须显式改断言，不能悄悄漂）
 *   ② **改了配置，规则真的跟着变**（不是"看起来能配，其实没生效"——最常见的假功能）
 *   ③ 配置错了**响亮地拒绝**，而且不会"改一半生效一半"
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { cfg, configure, resetParams, validatePatch, ParamError, param, defaultParams, snapshot, schema, PARAM_SPEC, fingerprint } from '../src/params.js';
import { doorFreeAngle, clearanceLevel } from '../src/clearance.js';
import { validateRoomSize } from '../src/room.js';
import { addItem } from '../src/placement.js';
import { createLayout } from '../src/room.js';

/** 实测门几何（demo-cabinet-800 / demo-freezer-dual，与 rules.json 的 catalog 同源） */
const DW829 = {
  w: 1.15192501, d: 1.09483496, h: 1.98669948,
  doors: [{
    node: 'outer_door', axis: 'y', openAngleDeg: 106,
    hinge: { x: 0.56298, y: 1.22, z: 0.42566 }, swing: 1.14635,
    leaf: { x0: -0.57596, x1: 0.57193, z0: 0.29557, z1: 0.54742 },
  }],
};
const DW510 = { w: 0.99, d: 0.8712, h: 1.98 };
const getProduct = (id) => ({ 'demo-cabinet-800': DW829, 'demo-freezer-dual': DW510 })[id];

test('默认值：就是文档里写的那几个数（用户 2026-09-21 拍板 90°/60°）', () => {
  assert.equal(cfg.door.openOkDeg, 90);
  assert.equal(cfg.door.openWarnDeg, 60);
  assert.equal(cfg.door.sweepStepDeg, 1);
  assert.equal(cfg.space.overlapTolM, 0.005);
  assert.equal(cfg.space.wallThicknessM, 0.12);
  assert.equal(cfg.space.snapM, 0.1);
  assert.equal(cfg.space.rotateStepDeg, 5);
  assert.equal(cfg.layout.maxItems, 100);
  assert.equal(cfg.room.minW, 3);
  assert.equal(cfg.room.maxW, 20);
  assert.equal(cfg.room.maxH, 5);
  assert.equal(cfg.walk.radiusM, 0.24);
  assert.equal(cfg.model.anisotropyWarn, 1.02);
  assert.equal(cfg.history.maxSteps, 40);
  assert.equal(cfg.column.minSideM, 0.2);
  assert.equal(cfg.column.maxSideM, 3);
  assert.equal(cfg.column.maxCount, 50);
  assert.equal(cfg.column.defaultSideM, 0.5);
});

test('② 改了配置，规则真的跟着变：阈值 90 → 70，同一布局从"黄灯"变"绿灯"', () => {
  try {
    // demo-freezer-dual 摆在门前方 1.98 m：demo-cabinet-800 的门能开 72°（不算"开到底"，但也不是撞住）
    const near = { w: 8, d: 6, h: 2.8, walls: [], items: [
      { id: 1, p: 'demo-cabinet-800', x: 2, z: 2, r: 0, doorAmount: 0 },
      { id: 2, p: 'demo-freezer-dual', x: 2, z: 3.98, r: 0, doorAmount: 0 },
    ] };
    const free = doorFreeAngle(near, near.items[0], getProduct).freeDeg;
    assert.equal(free, 72, '前提：这个布局的可开角度是 72°');
    assert.equal(clearanceLevel(free), 'warn', '默认阈值（90°）下算黄灯：能开但开不到底');

    configure({ door: { openOkDeg: 70 } });
    assert.equal(cfg.door.openOkDeg, 70);
    assert.equal(clearanceLevel(free), 'ok', '阈值降到 70° → 同一布局就"够用"了（绿灯）');
  } finally { resetParams(); }
  assert.equal(cfg.door.openOkDeg, 90, '恢复默认');
});

test('② 房间范围可配：把上限放到 30 m，原本非法的尺寸就合法了', () => {
  try {
    assert.equal(validateRoomSize(25, 6, 2.8), '长宽范围 3–20 m，墙高 2–5 m');
    configure({ room: { maxW: 30 } });
    assert.equal(validateRoomSize(25, 6, 2.8), null, '上限放宽后 25 m 合法');
    assert.equal(validateRoomSize(31, 6, 2.8), '长宽范围 3–30 m，墙高 2–5 m', '文案也跟着变，不会说谎');
  } finally { resetParams(); }
});

test('② 数量上限可配：上限改为 2 之后第 3 台被拒', () => {
  try {
    configure({ layout: { maxItems: 2 } });
    // addItem 是不可变的：必须接住返回的 layout（与 designer.add 同一用法）
    let l = createLayout({ w: 20, d: 20, h: 2.8 });
    for (let i = 0; i < 2; i++) {
      const r = addItem(l, 'demo-freezer-dual', { getProduct });
      assert.equal(r.ok, true, `第 ${i + 1} 台应当放得下`);
      l = r.layout;
    }
    assert.equal(l.items.length, 2);
    const third = addItem(l, 'demo-freezer-dual', { getProduct });
    assert.equal(third.ok, false);
    assert.match(third.message, /最多放置 2 台设备/, '提示文案里的数字也来自参数表');
  } finally { resetParams(); }
});

test('③ 配置错了要响亮：未知键 / 越界 / 非数字 一律拒绝', () => {
  const unknown = validatePatch({ door: { openOKDeg: 85 } });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors[0].message, /未知参数/, '大小写写错也必须报出来（静默无效是最坏的结果）');

  assert.equal(validatePatch({ door: { openOkDeg: 999 } }).ok, false);
  assert.equal(validatePatch({ door: { openOkDeg: '90' } }).ok, false);
  assert.equal(validatePatch({ nope: { x: 1 } }).ok, false);
  assert.equal(validatePatch(null).ok, false);
});

test('③ 跨字段规则：黄灯阈值不能高于绿灯阈值（否则"黄灯"这个级别没意义）', () => {
  const bad = validatePatch({ door: { openWarnDeg: 95, openOkDeg: 90 } });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].message, /不能高于/);
  assert.equal(validatePatch({ door: { openWarnDeg: 80, openOkDeg: 90 } }).ok, true, '合法组合要放行');
});

test('③ 非法配置**不会半途生效**：抛错后所有值保持原样', () => {
  const before = snapshot();
  assert.throws(() => configure({ door: { openOkDeg: 95, openWarnDeg: 100 } }), (e) => e instanceof ParamError);
  assert.deepEqual(snapshot(), before, '一个字段都不能被改掉');
  assert.throws(() => configure({ layout: { maxItems: 2, nope: 1 } }), ParamError);
  assert.equal(cfg.layout.maxItems, 100, 'maxItems 也不能生效（同一份补丁里有非法项 → 整体不生效）');
});

test('参数表本身自洽：path 唯一、默认值落在范围内、分组都存在', () => {
  const seen = new Set();
  for (const e of PARAM_SPEC) {
    assert.ok(!seen.has(e.path), `重复参数：${e.path}`);
    seen.add(e.path);
    assert.match(e.path, /^[a-z]+\.[a-zA-Z0-9]+$/, `path 形状不对：${e.path}`);
    assert.equal(typeof e.label, 'string', `${e.path} 缺中文名（后台表单要用）`);
    assert.equal(typeof e.help, 'string', `${e.path} 缺说明`);
    assert.ok(e.default >= e.min && e.default <= e.max, `${e.path} 默认值 ${e.default} 不在 ${e.min}~${e.max}`);
  }
});

test('param() 按路径取值；未登记的路径直接抛错（不许猜）', () => {
  assert.equal(param('door.openOkDeg'), 90);
  assert.throws(() => param('door.nope'), /未知参数/);
});

test('schema() 是后台表单的现成定义：分组齐全、每项带 label/范围/说明', () => {
  const sch = schema();
  assert.ok(sch.groups.length >= 6);
  const door = sch.groups.find((g) => g.id === 'door');
  // W1：这一组现在叫「设备柜门净空」—— 建筑门洞是另一组 `opening`，两个"门"名字上必须分得开
  assert.equal(door.label, '设备柜门净空');
  const opening = sch.groups.find((g) => g.id === 'opening');
  assert.equal(opening.label, '洞口（门洞 / 窗）');
  assert.equal(opening.params.length, 7, '门洞 7 条参数');
  const ok = door.params.find((p) => p.key === 'openOkDeg');
  assert.equal(ok.label, '绿灯阈值');
  assert.equal(ok.unit, '°');
  assert.deepEqual([ok.min, ok.max], [0, 180]);
  assert.ok(ok.help.includes('90'));
});

test('defaultParams() 是快照：改它不会影响生效值', () => {
  const d = defaultParams();
  d.door.openOkDeg = 1;
  assert.equal(cfg.door.openOkDeg, 90);
});
/**
 * 参数表指纹（B4a）
 *
 * 这一组测试要证明两件事，缺一不可：
 *   ① **默认配置的指纹是一个钉死的字面量**（= Java 侧 Params.fingerprint() 的那个数）——
 *      两边各钉一遍，"同一个配置两个指纹"这种错才拦得住；
 *   ② **洗一个数进去，指纹就变**。不然它就是"看起来在跟踪版本，其实永远一个数"。
 */
test('指纹：默认配置 = 1831018939（与 Java 侧同一个数）', () => {
  resetParams();
  // ⚠️ W5 加了 4 条 `column.*` → 指纹变了（上一版是 W4 之后的 29544604）。**两处必须一起改**
  // （这里与 Java `Params.fingerprint()` 的钉住值），否则"同一个配置两个指纹"。
  assert.equal(fingerprint(), 1831018939);
});

test('指纹：改任何一个生效值都会变（它跟的是生效值，不是默认值）', () => {
  resetParams();
  const base = fingerprint();

  configure({ door: { openOkDeg: 85 } });
  const changed = fingerprint();
  assert.notEqual(changed, base, '改了门开度阈值，指纹必须变');
  assert.equal(fingerprint(defaultParams()), base, '传默认值算出来的仍应是那个基线');

  // 改回去 → 指纹也回去（它只由"当前是什么值"决定，与改过几次无关）
  configure({ door: { openOkDeg: 90 } });
  assert.equal(fingerprint(), base);

  // 默认值本身没动过：也就是说这**不是**"默认值指纹"的巧合
  assert.equal(PARAM_SPEC.find((e) => e.path === 'door.openOkDeg').default, 90);
});

test('指纹：与参数表顺序绑定，且是稳定散列（同一份值算两次一样）', () => {
  resetParams();
  assert.equal(fingerprint(), fingerprint());
  // 参数表顺序就是指纹的输入顺序 —— 顺序变了指纹也变，这是刻意的（表变了就该是新版本）
  assert.equal(PARAM_SPEC[0].path, 'room.minW');
});

/**
 * 「允许改」与「允许装」是两件事（R6-4 B4a）
 *
 * 这一组测试是**被一次真事故逼出来的**：前端启动时把服务端发来的整份生效值
 * 装进内核，而那份里包含 `admin:false` 的项 —— 表单那条规则把整份都拒了，
 * 于是内核退回默认值、界面照旧按 5° 转，而谁都看不出来（只有 console 里一条 warn）。
 *
 * 所以：**写端（发布/表单）拦，读端（装配置）放**。两个方向都要钉住，
 * 只钉一个的话，改动任一侧都会悄悄破坏另一侧。
 */
test('装整份生效值：允许带上不允许在后台改的项（allowNonAdmin）', () => {
  resetParams();
  const all = defaultParams();                 // 45 项，含 7 项 admin:false
  assert.equal(PARAM_SPEC.filter((e) => !e.admin).length, 7);
  configure(all, { allowNonAdmin: true });     // 不抛 = 装得上
  assert.equal(cfg.door.sweepStepDeg, 1);
  resetParams();
});

test('不带这个选项时：仍然拦住不允许在后台改的项（表单那条路不能松）', () => {
  resetParams();
  const all = defaultParams();
  assert.throws(() => configure(all), (e) => e.name === 'ParamError' && /不允许改/.test(e.message));
  resetParams();
});
