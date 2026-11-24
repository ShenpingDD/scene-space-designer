/**
 * detail.test.js —— 设计端「产品 3D 详情」的判据（node 里跑，不需要浏览器/后端）
 *
 * 值钱的是这几条（都对应 docs/104 §四 与 docs/106 §6 的硬约定）：
 *   ① 详情用 **LOD1**，没有 lod1 时按 lod0 → lod2 回退，并**如实回报**用的是哪一级；
 *   ② 锚点只在**这一份模型**里解析（`nodePath + nodeIndex`）：重名节点不许串台，解析不了就是失效；
 *   ③ 不等比缩放报 `unit-mismatch`，不硬算坐标；
 *   ④ 门状态门控：`open/closed` 只由当前门开度决定，`any` 恒显；
 *   ⑤ 投影：模型中心投到画布中心，相机背后的点不许画；
 *   ⑥ 失效热点**不静默丢**：接口报的 + 本地解析失败的合并成同一张清单；
 *   ⑦ 接线：详情弹层里没有「放入布局」，Esc 是"先关热点、再关详情"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  DEFAULT_CAMERA, boxOf, cameraPose, chooseDetailLevel, contentOf, doorsOf, hotspotStatus,
  baseFor, invalidRows, pathWithin, projectPoint, reasonText, resolveHotspots, visibleAtDoor,
} from '../src/detail3d.js';

const DETAIL = readFileSync(new URL('../src/components/ProductDetail.vue', import.meta.url), 'utf8');
const RAIL = readFileSync(new URL('../src/components/ProductRail.vue', import.meta.url), 'utf8');

/* ---------------- ① LOD 选级 ---------------- */

test('详情固定 lod1：有 lod1 就用它，没有才回退（并让界面能说出用的是哪一级）', () => {
  assert.equal(chooseDetailLevel(['lod0', 'lod1', 'lod2']), 'lod1');
  assert.equal(chooseDetailLevel(['lod0', 'lod2']), 'lod0', '没有 lod1 时宁可清楚一点');
  assert.equal(chooseDetailLevel(['lod2']), 'lod2');
  assert.equal(chooseDetailLevel([]), null, '一级都没有 → null（界面要明说，不假装加载成功）');
  assert.equal(chooseDetailLevel(null), null);
});

/* ---------------- ②③ 锚点解析 ---------------- */

/** 造一棵"有重名节点"的小树：根/parent/{vent,vent} —— 正是真实模型里 `Vent slot` ×56 的缩小版 */
function tree() {
  const root = new THREE.Group();
  root.name = 'DEMO-FZ-040';
  const parent = new THREE.Group();
  parent.name = 'body';
  root.add(parent);
  const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  a.name = 'vent';
  const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  b.name = 'vent';
  b.position.set(0.5, 0, 0);
  parent.add(a, b);
  root.updateWorldMatrix(true, true);
  return { root, parent, a, b };
}

test('锚点唯一键是 nodePath + nodeIndex：两个同名节点靠序号分开，不按名字撞第一个', () => {
  const { root } = tree();
  const hs = (index) => ({
    id: index + 1, title: `v${index}`, nodePath: ['DEMO-FZ-040', 'body', 'vent'], nodeIndex: index,
    position: { x: 0, y: 0, z: 0 },
  });
  const { resolved, failed } = resolveHotspots(root, [hs(0), hs(1)]);
  assert.equal(failed.length, 0);
  assert.equal(resolved.length, 2);
  assert.notEqual(resolved[0].node, resolved[1].node, '序号不同必须落到不同节点');
  assert.equal(resolved[1].node.position.x, 0.5, 'index=1 是第二个同名节点');
});

test('解析不了 = 失效（anchor-missing），不按名字兜底、不静默丢弃', () => {
  const { root } = tree();
  const { resolved, failed } = resolveHotspots(root, [
    { id: 7, title: '跑掉的', nodePath: ['DEMO-FZ-040', 'no_such_node'], nodeIndex: 0, position: { x: 0, y: 0, z: 0 } },
    { id: 8, title: '序号越界', nodePath: ['DEMO-FZ-040', 'body', 'vent'], nodeIndex: 9, position: { x: 0, y: 0, z: 0 } },
  ]);
  assert.equal(resolved.length, 0);
  assert.deepEqual(failed.map((f) => f.reason), ['anchor-missing', 'anchor-missing']);
  assert.equal(failed[0].detail, 'DEMO-FZ-040/no_such_node');
});

test('锚点世界缩放不等比 → unit-mismatch（不硬算坐标）', () => {
  const { root, parent } = tree();
  parent.scale.set(0.001, 0.001, 0.0012);   // 三轴不等比
  root.updateWorldMatrix(true, true);
  const { resolved, failed } = resolveHotspots(root, [{
    id: 1, nodePath: ['DEMO-FZ-040', 'body', 'vent'], nodeIndex: 0, position: { x: 0.01, y: 0, z: 0 },
  }]);
  assert.equal(resolved.length, 0);
  assert.equal(failed[0].reason, 'unit-mismatch');
});

test('等比缩放（mm 素材 ×0.001）：存的是米，读出来仍是米', () => {
  const { root, parent, a } = tree();
  parent.scale.setScalar(0.001);
  root.updateWorldMatrix(true, true);
  const { resolved, failed } = resolveHotspots(root, [{
    id: 1, nodePath: ['DEMO-FZ-040', 'body', 'vent'], nodeIndex: 0,
    position: { x: 0.02, y: 0.03, z: 0.04 },   // 米（存在锚点局部）
  }]);
  assert.equal(failed.length, 0);
  assert.equal(resolved[0].node, a);
  // 细节在 hotspot.js 的单测里已钉住；这里只确认"能解析且不报错"，不重复验坐标算法
});

test('锚点路径以**模型根**为第 0 段：先对前缀，再逐段相等（不猜节点）', () => {
  const root = new THREE.Group();
  root.name = 'DEMO-FZ-040';
  assert.deepEqual(pathWithin(root, ['DEMO-FZ-040', 'upper_door']), ['DEMO-FZ-040', 'upper_door']);
  // 兼容"记录时把场景根也记进去了"的老数据（three 的 nodePathOf 会走到场景根）
  assert.deepEqual(pathWithin(root, ['#0', 'DEMO-FZ-040', 'upper_door']), ['DEMO-FZ-040', 'upper_door']);
  assert.deepEqual(pathWithin(root, []), []);
  assert.deepEqual(pathWithin(root, ['other_root', 'x']), ['other_root', 'x'], '前缀里没有模型根名就原样用，不瞎截');
});

test('基准节点：加载器的包装层不算模型根（真实的 lod 结构就长这样）', () => {
  // scene → 「DEMO-FZ-040:lod1」(gltf.js 给包装层改的名字) → 「DEMO-FZ-040」(GLB 自己的根) → upper_door
  const scene = new THREE.Scene();
  const wrapper = new THREE.Group();
  wrapper.name = 'DEMO-FZ-040:lod1';
  const glbRoot = new THREE.Group();
  glbRoot.name = 'DEMO-FZ-040';
  const door = new THREE.Group();
  door.name = 'upper_door';
  glbRoot.add(door);
  wrapper.add(glbRoot);
  scene.add(wrapper);
  scene.updateMatrixWorld(true);

  const hot = { id: 1, nodePath: ['DEMO-FZ-040', 'upper_door'], nodeIndex: 0, position: { x: 0, y: 0, z: 0 } };
  const r = resolveHotspots(wrapper, [hot]);
  assert.equal(r.failed.length, 0, '路径指向 GLB 自己的根 → 以它为基准解析');
  assert.equal(r.resolved[0].node, door);
  assert.equal(baseFor(wrapper, hot.nodePath), glbRoot, '基准取的是路径第一段那个节点，不是包装层');

  // 编辑器若把包装层名字也记进路径（跨 LOD 会变），也要能对上
  const withWrapper = { ...hot, nodePath: ['DEMO-FZ-040:lod0', 'DEMO-FZ-040', 'upper_door'] };
  assert.equal(resolveHotspots(wrapper, [withWrapper]).failed.length, 0);

  // 挂在场景里照样能解析（内部解析时会临时摘下基准节点，不受祖先影响）
  assert.equal(resolveHotspots(wrapper, [hot]).resolved.length, 1);
});

/* ---------------- ④ 门状态门控 ---------------- */

test('门状态门控：any 恒显；open 只在开度 ≥0.5 时可见；closed 反之', () => {
  assert.equal(visibleAtDoor({ doorState: 'any' }, 0), true);
  assert.equal(visibleAtDoor({ doorState: 'any' }, 1), true);
  assert.equal(visibleAtDoor({ doorState: 'open' }, 0), false);
  assert.equal(visibleAtDoor({ doorState: 'open' }, 0.5), true);
  assert.equal(visibleAtDoor({ doorState: 'closed' }, 0.49), true);
  assert.equal(visibleAtDoor({ doorState: 'closed' }, 1), false);
  assert.equal(visibleAtDoor({}, 0), true, '缺省 = any');
});

/* ---------------- ⑤ 相机与投影 ---------------- */

test('cameraPose：归一化参数 → 世界机位；距离随 distFactor 等比变化，与模型尺寸无关', () => {
  const box = { center: [0, 0.9, 0], size: [1, 1.8, 1] };
  const a = cameraPose({ ...DEFAULT_CAMERA, distFactor: 1 }, box);
  const b = cameraPose({ ...DEFAULT_CAMERA, distFactor: 2 }, box);
  const dist = (p) => Math.hypot(p.position[0] - p.target[0], p.position[1] - p.target[1], p.position[2] - p.target[2]);
  assert.ok(Math.abs(dist(b) / dist(a) - 2) < 1e-9, 'distFactor 翻倍，距离就要翻倍');
  // 同样的归一化参数换一款更大的模型：机位跟着包围盒走（不是写死的绝对坐标）
  const big = { center: [0, 0.9, 0], size: [2, 3.6, 2] };
  assert.ok(dist(cameraPose({ ...DEFAULT_CAMERA, distFactor: 1 }, big)) > dist(a), '大模型要站得更远');
  // target 0..1 → 包围盒内的绝对点
  const t = cameraPose({ ...DEFAULT_CAMERA, target: [1, 1, 1] }, box);
  assert.ok(Math.abs(t.target[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(t.target[1] - 1.8) < 1e-9, 'target y=1 → 包围盒顶面');
});

test('projectPoint：包围盒中心投到画面中心；相机背后的点 visible=false', () => {
  const box = { center: [0, 0.9, 0], size: [1, 1.8, 1] };
  const pose = cameraPose(DEFAULT_CAMERA, box);
  const cam = new THREE.PerspectiveCamera(DEFAULT_CAMERA.fov, 1.5, 0.02, 60);
  cam.position.set(...pose.position);
  cam.lookAt(new THREE.Vector3(...pose.target));
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const W = 600; const H = 400;

  // 相机对准的是 `pose.target`（归一化 target 0.5/0.52/0.5 换算出来的点），不是包围盒中心
  const center = projectPoint(pose.target, cam, W, H);
  assert.equal(center.visible, true);
  assert.ok(Math.abs(center.x - W / 2) < 1e-6);
  assert.ok(Math.abs(center.y - H / 2) < 1e-6);

  // 相机背后（沿视线反方向很远的一点）必须是不可见
  const back = projectPoint([
    pose.position[0] + (pose.position[0] - pose.target[0]) * 3,
    pose.position[1] + (pose.position[1] - pose.target[1]) * 3,
    pose.position[2] + (pose.position[2] - pose.target[2]) * 3,
  ], cam, W, H);
  assert.equal(back.visible, false);
});

test('boxOf：读的是 Box3 实测（量化模型不能读 accessor.min/max）', () => {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.8, 0.5));
  m.position.set(0, 0.9, 0);
  g.add(m);
  g.updateMatrixWorld(true);
  const b = boxOf(g);
  assert.ok(Math.abs(b.size[1] - 1.8) < 1e-6);
  assert.ok(Math.abs(b.center[1] - 0.9) < 1e-6);
});

/* ---------------- ⑥ 内容与失效清单 ---------------- */

test('contentOf：发布快照与老产品只读投影两种形状都吃得下', () => {
  const published = contentOf({
    content: {
      description: '双温双控',
      sellingPoints: [{ label: '独立双控', text: '上下箱独立' }],
      params: [{ key: '有效容积', value: '510', unit: 'L', group: '基础' }],
    },
  });
  assert.equal(published.description, '双温双控');
  assert.deepEqual(published.sellingPoints, [{ label: '独立双控', text: '上下箱独立' }]);
  assert.deepEqual(published.params, [{ key: '有效容积', value: '510', unit: 'L', group: '基础' }]);

  // legacy-projection：params 是 [[label,value]]，sellingPoints 是「label：value」字符串
  const legacy = contentOf({
    content: { description: '老产品', sellingPoints: ['独立双控：上下箱独立'], params: [['有效容积', '510 L']] },
  });
  // 投影里的「名称：内容」按第一个全角冒号拆开（拆不开就整串当正文，不丢内容）
  assert.deepEqual(legacy.sellingPoints[0], { label: '独立双控', text: '上下箱独立' });
  assert.deepEqual(legacy.params, [{ key: '有效容积', value: '510 L', unit: '', group: '' }]);
  assert.deepEqual(contentOf(null).sellingPoints, [], '缺字段时是空数组，界面据此隐藏空区块');
});

test('invalidRows：接口报的 + 本地解析失败合并，去重但不吞条数', () => {
  const detail = {
    invalidReasons: [
      { hotspotId: 13, reason: 'anchor-missing', detail: 'X/upper_door' },
      { hotspotId: 14, reason: 'model-changed', detail: 'default:9f2c' },
    ],
  };
  const local = [
    { hotspot: { id: 13 }, reason: 'anchor-missing', detail: 'X/upper_door' },   // 与接口那条重复
    { hotspot: { id: 15, title: '托盘' }, reason: 'unit-mismatch', detail: '锚点世界缩放不等比' },
  ];
  const rows = invalidRows(detail, local);
  assert.equal(rows.length, 3, '重复的合并、独有的一条不少');
  assert.deepEqual(rows.map((r) => r.reason), ['anchor-missing', 'model-changed', 'unit-mismatch']);
  assert.equal(rows[2].title, '托盘');
});

test('原因要说人话：4 个代码都有可读句，未知代码不抛', () => {
  for (const code of ['anchor-missing', 'index-out-of-range', 'unit-mismatch', 'model-changed']) {
    assert.ok(!reasonText(code).includes(code), `${code} 不该把代码本身直接摆给用户看`);
  }
  assert.ok(reasonText('mystery').length > 0);
});

test('状态角标：没热点 none / 全有效 ok / 有失效 review（判据只用计数，不猜）', () => {
  assert.equal(hotspotStatus({ counts: { total: 0 } }, 0), 'none');
  assert.equal(hotspotStatus({ counts: { total: 3 } }, 0), 'ok');
  assert.equal(hotspotStatus({ counts: { total: 3 } }, 1), 'review');
  assert.equal(hotspotStatus({ hotspots: [{ id: 1 }] }, 0), 'ok', '接口只给 hotspots[] 时也能算');
});

test('doorsOf：配方声明的门（弧度）优先；只有目录门（角度）时才换算', () => {
  assert.deepEqual(
    doorsOf({ hinges: [{ name: 'upper_door', axis: 'y', openAngle: 1.85 }], doors: [{ node: 'x', axis: 'z', openAngleDeg: 90 }] }),
    [{ node: 'upper_door', axis: 'y', openAngleRad: 1.85 }],
  );
  const deg = doorsOf({ doors: [{ node: 'outer_door', axis: 'y', openAngleDeg: 106 }] });
  assert.equal(deg[0].node, 'outer_door');
  assert.ok(Math.abs(deg[0].openAngleRad - (106 * Math.PI) / 180) < 1e-9);
  assert.deepEqual(doorsOf({}), [], '没有门就是空数组（详情里就没有门控的目标，不崩）');
});

/* ---------------- ⑦ 接线（源码级） ---------------- */

test('详情弹层：只读、有 DOM 钩子、Esc 先关热点再关详情、无「放入布局」', () => {
  assert.match(DETAIL, /data-product-detail/);
  assert.match(DETAIL, /data-product-detail-close/);
  assert.match(DETAIL, /data-detail-stage/);
  assert.match(DETAIL, /data-detail-popover/);
  assert.match(DETAIL, /data-detail-markers/);
  assert.match(DETAIL, /data-detail-door-state/);
  assert.match(DETAIL, /data-detail-read/);
  assert.match(DETAIL, /data-detail-invalid-count/);
  assert.match(DETAIL, /data-detail-index-id/, '索引行要有自己的钩子（不与舞台标记的 data-hs-id 混用）');
  assert.match(DETAIL, /data-detail-empty/);
  assert.match(DETAIL, /aria-modal="true"/);
  assert.match(DETAIL, /role="dialog"/);
  // 两级 Esc：activeId 先判、closePopover 先返回（顺序写反 = 按一次 Esc 就把详情关了）
  const esc = DETAIL.slice(DETAIL.indexOf("if (e.key === 'Escape')"), DETAIL.indexOf("if (e.key !== 'Tab')"));
  assert.ok(esc.indexOf('closePopover') < esc.indexOf('closeAll'), 'Esc 必须先关热点弹层、再关详情');
  // 只读：不写入方案、不放进布局
  assert.ok(!/d\.add\(/.test(DETAIL), '详情里不许出现「放入布局」那条调用');
  assert.ok(!/d\.selectItem\(/.test(DETAIL), '详情不改主画布的选中');
  assert.match(DETAIL, /Teleport to="body"/, '模态要挂到 body，否则会被侧栏 overflow 裁掉');
});

test('异步竞态：等接口/等模型的路上被关掉，迟到结果不许写回界面', () => {
  // 这是"点开就关"那类操作唯一的正确性要求：旧会话的结果不能把已关闭的弹层弄脏
  assert.match(DETAIL, /if \(!props\.open \|\| props\.product !== p\) return;/);
  assert.match(DETAIL, /if \(!props\.open \|\| viewer !== v\) return;/);
  assert.match(DETAIL, /const v = viewer/);
});

test('缩略图入口：是 button，带 data-has-detail；＋ 仍是独立的放入布局按钮', () => {
  assert.match(RAIL, /data-product-thumb/);
  assert.match(RAIL, /data-has-detail/);
  assert.match(RAIL, /emit\('open-detail'/);
  // 「＋」只调 d.add 且 stopPropagation（点加号不该顺手打开详情）；
  // docs/104 §7.1 要求它带 `data-product-add`，探针据此验证「点加号不会误开详情」
  const add = RAIL.slice(RAIL.indexOf('class="product__add"'), RAIL.indexOf('product__add"') + 260);
  assert.match(add, /data-product-add/);
  assert.match(add, /@click\.stop="d\.add\(p\.id\)"/);
});

test('目录「刷新」不再只在本地兜底时出现（server 源也有手动入口）', () => {
  const retry = RAIL.slice(RAIL.indexOf('data-catalog-retry') - 260, RAIL.indexOf('data-catalog-retry') + 40);
  assert.ok(!/v-if="d\.catalogSource !== 'server'"/.test(retry), '手动刷新不该被来源挡住');
  assert.match(RAIL, /refreshCatalog\(\{ force: true/);
});


test('0 热点空态移到右侧索引，不盖住 canvas；all-invalid 仍留在舞台', () => {
  const stage = DETAIL.slice(DETAIL.indexOf('data-detail-stage'), DETAIL.indexOf('data-detail-popover'));
  assert.ok(!stage.includes('data-detail-empty="no-hotspot"'), '舞台上的 no-hotspot 浮层必须删掉');
  assert.match(DETAIL, /data-detail-section="hotspot-index"[\s\S]*?data-detail-empty="no-hotspot"/);
  const empty = DETAIL.slice(DETAIL.indexOf('data-detail-empty="no-hotspot"') - 220,
    DETAIL.indexOf('data-detail-empty="no-hotspot"') + 120);
  assert.match(empty, /class="[^"]*pd__empty/);
  assert.ok(!empty.includes('pd__note'), '右侧空态不是舞台浮层样式');
  assert.equal((DETAIL.match(/data-detail-empty="no-hotspot"/g) || []).length, 1, '钩子只保留一处');
  assert.match(DETAIL, /data-detail-empty="all-invalid"/, 'all-invalid 警告必须保留');
});
