import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HOTSPOT_LIMITS, newHotspot, normalizeHotspot, countsOf, canAdd, charCount, limitText,
  validateHotspot, validateDraft, validateContent, hotspotsPayload, validationOf,
  contentPayload, cameraFromOrbit, orbitFromCamera, nodeOptionLabel,
} from '../src/admin/hotspot-edit.js';

/* 这些数一旦被改动，必须有人被测试拦下：50/40/300/8/200/50 是 Lead 冻结口径。 */
test('冻结上限：50 热点 / 标题 40 / 正文 300 / 卖点 8×200 / 参数 50', () => {
  assert.equal(HOTSPOT_LIMITS.hotspots, 50);
  assert.equal(HOTSPOT_LIMITS.title, 40);
  assert.equal(HOTSPOT_LIMITS.body, 300);
  assert.equal(HOTSPOT_LIMITS.sellingPoints, 8);
  assert.equal(HOTSPOT_LIMITS.sellingPointChars, 200);
  assert.equal(HOTSPOT_LIMITS.params, 50);
});

test('字符数按码点算，limitText 不把 emoji 切成半个', () => {
  assert.equal(charCount('热点'), 2);
  assert.equal(charCount('🔥'), 1);
  assert.equal(limitText('a🔥b', 2), 'a🔥');
});

test('新建热点有临时 string id，不伪造 number id', () => {
  const h = newHotspot(0, { title: '门把手' });
  assert.equal(typeof h.id, 'string');
  assert.match(h.id, /^new-/);
  assert.equal(h.seq, 0);
  assert.deepEqual(h.camera.azimuthDeg, 28);
  assert.equal(h.doorState, 'any');
});

test('计数把失效热点算进来，绝不静默少显示', () => {
  const list = [
    newHotspot(0, { title: 'a' }),
    { ...newHotspot(1, { title: 'b' }), id: 7, invalidReason: 'anchor-missing' },
    { ...newHotspot(2, { title: 'c' }), id: 8, invalidReason: 'unit-mismatch' },
  ];
  assert.deepEqual(countsOf(list), { total: 3, valid: 1, invalid: 2 });
});

test('0 热点可保存；第 51 条才拒绝新增', () => {
  assert.equal(validateDraft([]).length, 0);
  assert.equal(canAdd(new Array(49).fill(0)), true);
  assert.equal(canAdd(new Array(50).fill(0)), false);
  const issues = validateDraft(new Array(51).fill(0).map((_, i) => newHotspot(i, { title: 'h' + i })));
  assert.equal(issues.some((x) => x.code === 'hotspot-too-many'), true);
});

test('标题/正文必填、40/300 当场拦，且空标题也拦', () => {
  const h = newHotspot(0, { title: 'x'.repeat(41) });
  const codes = validateHotspot(h).map((x) => x.code);
  assert.ok(codes.includes('title-too-long'));
  assert.ok(codes.includes('body-required'), '正文为空是结构错误，不能写半条数据');
  const h2 = newHotspot(1, { title: 'ok', body: 'y'.repeat(301) });
  assert.ok(validateHotspot(h2).some((x) => x.code === 'body-too-long'));
  const h3 = newHotspot(2, { title: '   ' });
  assert.ok(validateHotspot(h3).some((x) => x.code === 'title-required'));
  const h4 = newHotspot(3, { title: '标题', body: '正文', nodePath: ['root'], nodeIndex: 0 });
  assert.equal(validateHotspot(h4).length, 0);
});

test('失效锚点不是结构错误：空 nodePath 也能保存（只留 warning）', () => {
  const h = { ...newHotspot(0, { title: '旧热点', body: '正文' }), id: 3, invalidReason: 'anchor-missing' };
  assert.equal(validateDraft([h]).length, 0);
  const fresh = newHotspot(1, { title: '新热点' });
  assert.ok(validateDraft([fresh]).some((x) => x.code === 'anchor-required'), '新热点仍必须有锚点');
});

test('卖点最多 8 条、每条 200 字；参数最多 50 条且 key 唯一', () => {
  const sp = new Array(9).fill('卖点');
  assert.ok(validateContent({ sellingPoints: sp }).some((x) => x.code === 'selling-too-many'));
  assert.ok(validateContent({ sellingPoints: ['z'.repeat(201)] }).some((x) => x.code === 'selling-too-long'));
  const params = new Array(51).fill({ key: 'k', value: 'v' });
  assert.ok(validateContent({ params }).some((x) => x.code === 'param-too-many'));
  assert.ok(validateContent({ params: [{ key: 'A', value: '1' }, { key: 'A', value: '2' }] })
    .some((x) => x.code === 'param-duplicate'));
});

test('payload 去掉临时 id 与编辑器内部 invalidReason，seq 重排', () => {
  const a = { ...newHotspot(5, { title: 'a' }), id: 'new-1', invalidReason: 'anchor-missing' };
  const b = { ...newHotspot(2, { title: 'b' }), id: 12 };
  const out = hotspotsPayload([a, b]);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'b');
  assert.equal(out[0].id, 12);
  assert.equal('invalidReason' in out[0], false);
  assert.equal('id' in out[1], false);
  assert.deepEqual(out.map((x) => x.seq), [0, 1]);
});

test('validation 只带 number id 的失效热点；临时 id 不进入 validation', () => {
  const list = [
    { ...newHotspot(0, { title: 'a' }), id: 9, invalidReason: 'anchor-missing', invalidDetail: 'root/x' },
    { ...newHotspot(1, { title: 'b' }), id: 'new-2', invalidReason: 'unit-mismatch' },
  ];
  const v = validationOf(list, { variant: 'default', checksum: 'abc', unit: 'mm' });
  assert.equal(v.invalid.length, 1);
  assert.equal(v.invalid[0].hotspotId, 9);
  assert.equal(v.modelFingerprint, 'default:abc');
  assert.equal(v.unit, 'mm');
});

test('内容 payload 去空行、去空白，简介不在里面', () => {
  const p = contentPayload({
    description: '不应提交',
    sellingPoints: ['  低温  ', '', '静音'],
    params: [{ key: ' 容积 ', value: ' 510 ', unit: ' L ', group: '' }, { key: '', value: 'x' }],
  });
  assert.deepEqual(p.sellingPoints, ['低温', '静音']);
  assert.deepEqual(p.params, [{ key: '容积', value: '510', unit: 'L', group: '' }]);
  assert.equal('description' in p, false);
});

test('归一化相机与世界机位互逆（误差 ≤ 1e-6）', () => {
  const bbox = { min: [-0.5, 0, -0.4], size: [1, 2, 0.8] };
  const cam = { azimuthDeg: 35, elevationDeg: 12, distFactor: 1.8, target: [0.5, 0.55, 0.5], fov: 42 };
  const w = cameraFromOrbit(cam, bbox);
  const back = orbitFromCamera(w.position, w.target, bbox, w.fov);
  assert.ok(Math.abs(back.azimuthDeg - 35) < 1e-6);
  assert.ok(Math.abs(back.elevationDeg - 12) < 1e-6);
  assert.ok(Math.abs(back.distFactor - 1.8) < 1e-6);
  assert.ok(Math.abs(back.target[1] - 0.55) < 1e-6);
});

test('节点下拉只显示末段 + 同名序号，不冒充唯一键', () => {
  assert.equal(nodeOptionLabel(['root', 'Vent slot'], 0), 'Vent slot');
  assert.equal(nodeOptionLabel(['root', 'Vent slot'], 3), 'Vent slot #3');
});

test('看板根节点带 docs/104 §7.1 的探针钩子（看板/三步流程/产品 id/上限）', () => {
  const src = readFileSync(new URL('../src/admin/HotspotBoard.vue', import.meta.url), 'utf8');
  assert.match(src, /data-hotspot-board/);
  assert.match(src, /data-hotspot-step="3"/);
  assert.match(src, /:data-hotspot-product-id="productId"/);
  assert.match(src, /:data-hotspot-limit="LIMITS\.hotspots"/);
  assert.match(src, /data-editor-save/);
  assert.match(src, /data-board-back/);
  for (const hook of ['data-hotspot-invalid-count', 'data-hotspot-mode', 'data-hotspot-door-state',
    'data-hotspot-selected-id', 'data-hotspot-view', 'data-hotspot-list', 'data-hotspot-editor',
    'data-hotspot-coord', 'data-hotspot-max-reached', 'data-hs-row', 'data-hs-id',
    'data-hs-node-path', 'data-hs-node-index', 'data-hs-visible-when', 'data-hs-selected']) {
    assert.match(src, new RegExp(hook), hook + ' 必须留在看板 DOM 上，探针只认 data-*');
  }
});


/* ---------------- 验收-2：浅色看板 / 锚点引导 / 真实门节点 ---------------- */

const BOARD = readFileSync(new URL('../src/admin/HotspotBoard.vue', import.meta.url), 'utf8');
const ADMIN_CSS = readFileSync(new URL('../src/admin/admin.css', import.meta.url), 'utf8');

test('看板 3D 统一浅色：场景/半球光/方向光/网格/空场景与 detail3d 同口径', () => {
  assert.match(BOARD, /new THREE\.Scene\(\)[\s\S]*setupSceneLighting\(\)/, '有模型和无模型都要走同一套浅色灯光');
  assert.match(BOARD, /new THREE\.Color\(0xf2f6f9\)/);
  assert.match(BOARD, /HemisphereLight\(0xffffff, 0x9fb3c0, 2\.1\)/);
  assert.match(BOARD, /DirectionalLight\(0xffffff, 1\.6\)/);
  assert.match(BOARD, /GridHelper\(6, 24, 0xb9cbd7, 0xe2ebf1\)/);
  assert.ok(!BOARD.includes('0x10202a'), '看板不再保留深海蓝背景');
  assert.match(ADMIN_CSS, /\.hsb__stage \{[^}]*background: #f2f6f9/);
  assert.match(ADMIN_CSS, /\.hsb__stage-foot \{[^}]*background: #eaf1f6/);
  // 浅色台上标记靠深色外环保持边界；不能只剩一圈白边
  assert.match(ADMIN_CSS, /\.hsb__marker \{[^}]*box-shadow: 0 0 0 1px rgb\(15 23 42 \/ 38%\)/);
});

test('门优先消费 model.hingeNodes：nodes 展开、path/name 解析、角度转弧度、缺失禁用', () => {
  assert.match(BOARD, /hingeNodes: Array\.isArray\(m\.hingeNodes\) \? m\.hingeNodes : \[\]/);
  assert.match(BOARD, /expandHingeDefs/);
  assert.match(BOARD, /Array\.isArray\(h\.nodes\)/);
  assert.match(BOARD, /resolveDoorNode/);
  assert.match(BOARD, /def\.nodePath/);
  assert.match(BOARD, /Math\.PI\) \/ 180/);
  assert.match(BOARD, /String\(def\.axis \|\| 'y'\)\.toLowerCase\(\)/);
  // 缺失时：警告 + 清空绑定（按钮 disabled，不发假动画）
  assert.match(BOARD, /门节点找不到：/);
  assert.match(BOARD, /doorBindings = \[\];[\s\S]*doorWarning\.value = '门节点找不到/);
  assert.match(BOARD, /data-door-warning/);
  assert.match(BOARD, /data-door-state/);
  assert.match(BOARD, /:disabled="doorDisabled"/);
  assert.match(BOARD, /不会播放假动画/);
  assert.ok(!BOARD.includes('AnimationMixer'), '不接 AnimationMixer');
  // 严格只用后端 hingeNodes：没有数据就禁用，不退回 analysis/名字启发
  assert.ok(!/\/door\|lid\|drawer\/i/.test(BOARD), '不许再靠门/盖/抽屉名字猜门');
  assert.ok(!/props\.analysis\.doors/.test(BOARD), '不许把 analysis.doors 当开门依据');
});

test('锚点引导：业务语言 label、面包屑、原始路径折叠、当前锚点、3 条规则、最近命名节点', () => {
  assert.match(BOARD, /挂在哪个零件上/);
  assert.ok(!BOARD.includes('锚点节点（nodePath + index）'), '不再用实现术语当 label');
  assert.match(BOARD, /crumb: n\.path\.join\(' › '\)/);
  assert.match(BOARD, /data-anchor-current/);
  assert.match(BOARD, /当前锚点：/);
  assert.match(BOARD, /data-anchor-raw/);
  assert.match(BOARD, /<details[^>]*data-anchor-raw/);
  assert.match(BOARD, /data-anchor-help/);
  assert.match(BOARD, /nearestNamedAnchor/);
  assert.match(BOARD, /const a = nearestNamedAnchor\(hit\.object\)/);
  // 三条规则是 3 个 li，不能只写一句“请选择”
  const help = BOARD.slice(BOARD.indexOf('data-anchor-help'), BOARD.indexOf('</div>', BOARD.indexOf('data-anchor-help')));
  assert.equal((help.match(/<li>/g) || []).length, 3);
  // 旧钩子不能丢
  assert.match(BOARD, /data-hs-field="anchor"/);
  assert.match(BOARD, /data-hs-node-path/);
});

test('验收-2 看板只标热点：产品内容编辑与内容写接口都已移出看板', () => {
  assert.ok(!BOARD.includes('hsb__content'), '看板不再有产品内容折叠块');
  assert.ok(!BOARD.includes('＋ 卖点'), '看板不再能新增卖点');
  assert.ok(!BOARD.includes('contentDirty'), '内容脏标记必须删除，避免继续写产品内容');
  assert.ok(!BOARD.includes('adminSaveProductContent'), '保存只写热点，不再 PUT /content');
  assert.ok(!BOARD.includes('contentPayload'), '不再组装产品内容 payload');
  assert.match(BOARD, /adminSaveProductHotspots/, '热点仍走 /hotspots');
  assert.match(BOARD, /adminPublishProductContent/, '保存后仍自动发布');
  // 门 / 锚点 / 空态这些看板职责不能跟着被删掉
  assert.match(BOARD, /data-door-toggle/);
  assert.match(BOARD, /data-anchor-help/);
  assert.match(BOARD, /data-detail-empty|hsb__empty/);
});
