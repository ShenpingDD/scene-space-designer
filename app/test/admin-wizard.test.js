import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STEPS, ORDER, validateBasic, normalizeModelNo, modelNoTaken,
  pickRows, checkSummary, canSubmit, buildPayload, slugify,
  orderOf, canOpenHotspotBoard, modelOf, variantPayload, manualPayload, nextVariantName, dimsOf, confirmRows,
  declaredMissing, declaredSourceOf,
  doorOptionsOf, hingeNodesJson, contentOf, STEP_LABEL,
} from '../src/admin/wizard.js';
import { envelopeOkFor, anisotropyOf } from '../src/admin/analyze.js';

/* 向导是「哪一步能过 / 依据是什么 / payload 拼得对不对」三件事的纯计算。
   这里全部钉**字面量**，不读实现的常量 —— 读常量就抓不到「常量本身被改错」。 */

test('新增产品三步固定：basic → model → hotspots（confirm 不再是 create 的独立步骤）', () => {
  assert.deepEqual(ORDER, ['basic', 'model', 'hotspots']);
  assert.equal(STEPS.HOTSPOTS, 'hotspots');
  assert.equal(STEPS.CONFIRM, 'confirm', 'variant / manual 仍保留 confirm 语义');
});

test('第 1 步：缺项一次报全部（不是只报第一个）', () => {
  const r = validateBasic({});
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 3, '三项必填应一次全报出来');
  assert.deepEqual(r.missing.map((m) => m.label), ['产品名称', '产品型号', '产品简介']);
});

test('第 1 步：空白串不算填了', () => {
  const r = validateBasic({ name: '   ', modelNo: 'DEMO-FZ-040', description: '	' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.map((m) => m.key), ['name', 'description']);
});

test('第 1 步：三项齐了就放行', () => {
  const r = validateBasic({ name: 'A', modelNo: 'B', description: 'C' });
  assert.equal(r.ok, true);
  assert.equal(r.missing.length, 0);
});

test('型号撞号：空格与大小写不算两个型号', () => {
  assert.equal(normalizeModelNo('  demo-ct-100 '), 'DEMO-CT-100');
  const products = [{ modelNo: 'DEMO-CT-100' }, { modelNo: 'DEMO-FZ-25C' }];
  assert.equal(modelNoTaken(products, '  demo-ct-100 '), true);
  assert.equal(modelNoTaken(products, 'DEMO-999'), false);
  assert.equal(modelNoTaken(null, 'DEMO-CT-100'), false, '没数据时不许炸');
  assert.equal(modelNoTaken(products, ''), false);
});

test('自动拾取摊成 6 行，顺序照 docs/32 §2.2 那张图', () => {
  const rows = pickRows({
    picks: {
      thumb: { auto: true, confidence: 1, evidence: 'E1' },
      size: { w: 1, h: 2, d: 3, auto: true, confidence: 1, evidence: 'E2' },
      topView: { auto: true, confidence: 1, evidence: 'E3' },
      envelope: { mode: '1:1', auto: true, confidence: 1, evidence: 'E4' },
      front: { picked: 'z+', auto: true, confidence: 0.9, evidence: 'E5' },
      door: { doorPart: 'single', auto: true, confidence: 0.95, evidence: 'E6', humanRequired: true },
    },
  });
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((r) => r.key), ['thumb', 'size', 'topView', 'envelope', 'front', 'door']);
  assert.equal(rows[5].humanRequired, true);
  assert.equal(rows[0].confidence01, 1);
});

test('机器不敢猜时必须明说，不许用 0 置信度的值冒充', () => {
  const rows = pickRows({
    picks: {
      thumb: {}, size: {},
      topView: {},
      envelope: { mode: null, auto: false, confidence: 0, evidence: '没有声明尺寸' },
      front: { picked: null, auto: false, confidence: 0, evidence: '门在模型正中' },
      door: {},
    },
  });
  assert.match(rows[4].note, /不敢猜/);
  assert.match(rows[3].note, /人工确认/);
  assert.equal(rows[4].auto, false);
});

test('体检按严重度分组，bad 才算拦', () => {
  const s = checkSummary([
    { key: 'a', level: 'ok', text: 'ok1' },
    { key: 'b', level: 'warn', text: 'warn1' },
    { key: 'c', level: 'warn', text: 'warn2' },
  ]);
  assert.equal(s.ok.length, 1);
  assert.equal(s.warn.length, 2);
  assert.equal(s.bad.length, 0);
  assert.equal(checkSummary(null).total, 0, '没数据不许炸');
});

test('缺门节点不拦人（设计明文：门型降级人工选，不是拒绝入库）', () => {
  const r = canSubmit({
    checks: [
      { key: 'doorNodes', level: 'warn', text: '找不到任何约定门节点' },
      { key: 'parse', level: 'ok', text: 'GLB 可解析' },
    ],
  });
  assert.equal(r.ok, true, '只有 warn 就该放行');
  assert.deepEqual(r.blockers, []);
});

test('只有 bad 才拦，且把原因带出来', () => {
  const r = canSubmit({ checks: [{ key: 'x', level: 'bad', text: '尺寸单位不是 mm' }] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.blockers, ['尺寸单位不是 mm']);
  assert.equal(canSubmit(null).ok, false);
});

test('payload 形状与后端逐字对应：{product, model, notes}', () => {
  const p = buildPayload(
    { name: ' 深冷柜 ', modelNo: 'DEMO-FZ-040', description: ' 简介 ' },
    {
      ok: true,
      picks: {
        size: { w: 610, h: 1875, d: 616 },
        door: { doorPart: 'double' },
        envelope: { mode: 'fit' },
      },
    },
    { sourceFilePath: 'assets/uploads/ab.glb' },
  );
  assert.deepEqual(Object.keys(p), ['product', 'model', 'notes']);
  assert.equal(p.product.name, '深冷柜', '两端空白应被去掉');
  assert.equal(p.product.modelNo, 'DEMO-FZ-040');
  assert.equal(p.product.status, 'draft', '新建必须是 draft，不能是 active');
  const recipe = JSON.parse(p.product.recipeJson);
  assert.match(recipe.id, /^[a-z0-9][a-z0-9_-]{0,31}$/, 'recipeJson.id 必须是后端 SLUG 认的 ASCII slug');
  assert.equal(recipe.unit, 'mm');
  assert.equal(p.model.sourceFilePath, 'assets/uploads/ab.glb');
  assert.deepEqual([p.model.bboxW, p.model.bboxD, p.model.bboxH], [610, 616, 1875], 'W/D/H 不许错位');
  // 这一行原本断言的是**另一个字段名**（见 git 历史），它把那 个错名字钉住了 ——
  // 所以此前几十条测试全绿，也拦不住后端回「缺 unit」。测试钉错行为比没有测试更坏：
  // 它让人以为这条路已经验过了。现在断言 unit —— 后端读的就是它。
  assert.equal(p.model.unit, 'mm');
  assert.equal(p.model.doorPart, 'double');
  assert.equal(p.model.envelopeMode, 'fit');
});

test('人工改过的值优先，没改的才用自动值', () => {
  const p = buildPayload(
    { name: 'A', modelNo: 'M', description: 'D' },
    { ok: true, picks: { size: { w: 1, h: 2, d: 3 }, door: { doorPart: 'top' } } },
    { bboxW: 999, doorPart: 'single' },
  );
  assert.equal(p.model.bboxW, 999, '人工值应覆盖自动值');
  assert.equal(p.model.doorPart, 'single');
  assert.equal(p.model.bboxH, 2, '没改的仍用自动值');
});

test('slugify：中文/空格/大写/超长都要变成合法 slug', () => {
  assert.equal(slugify('DEMO-FZ-040'), 'demo-fz-040');
  assert.equal(slugify('  深冷柜 DEMO 829  '), 'demo-829');
  assert.equal(slugify('---'), '');
  assert.equal(slugify('a'.repeat(50)).length, 32, '超长要截到 32（后端 SLUG 上限）');
  assert.match(slugify('A_B-C'), /^[a-z0-9][a-z0-9_-]*$/);
});

test('pickRows(null) 仍返回 6 行 —— 所以 rows.length 不能当「已分析」的判据（R6-2-3e-1）', () => {
  // 这条钉的是一个**真的炸过界面**的事实：pickRows 对 null 是安全的，
  // 但它**永远给 6 行**。于是 `v-if="rows.length"` 在 analysis 还是 null 时也成立，
  // 表里的 `analysis.picks.*` 当场抛 TypeError: Cannot read properties of null (reading 'picks')，
  // 整个组件渲染失败 —— 表现是「点了下一步，界面纹丝不动」。
  // 所以判据必须是 `v-if="analysis"`。这里写字面量 6，就是为了让「恒为 6 行」一旦被改动，
  // 立刻有人被这条测试拦下。
  const rows = pickRows(null);
  assert.equal(rows.length, 6);
});

test('门节点映射：analysis.doors.found → {node,axis,openAngleDeg}，可全选/全不选', () => {
  const analysis = {
    picks: { size: { w: 600, d: 700, h: 800 } },
    doors: {
      found: [
        { node: 'outer_door', expectAxis: 'y', angleDeg: 106.4, part: 'single', specCompliant: true, side: '+z' },
        { node: 'top_lid', expectAxis: 'x', angleDeg: null, part: 'top', specCompliant: false, side: null },
      ],
    },
  };
  const opts = doorOptionsOf(analysis);
  assert.deepEqual(opts.map((d) => d.node), ['outer_door', 'top_lid']);
  assert.equal(opts[0].axis, 'y');
  assert.equal(opts[0].openAngleDeg, 106.4);
  assert.equal(opts[0].angleFromModel, true);
  assert.equal(opts[1].openAngleDeg, 106, '模型没标 extras 时用项目默认开角，但 angleFromModel=false');
  assert.equal(opts[1].angleFromModel, false);
  assert.deepEqual(doorOptionsOf(null), [], '没分析结果不许炸');

  assert.deepEqual(JSON.parse(hingeNodesJson(analysis)), [
    { node: 'outer_door', axis: 'y', openAngleDeg: 106.4 },
    { node: 'top_lid', axis: 'x', openAngleDeg: 106 },
  ], '不传 selected = 全选');
  assert.deepEqual(JSON.parse(hingeNodesJson(analysis, ['outer_door'])), [
    { node: 'outer_door', axis: 'y', openAngleDeg: 106.4 },
  ]);
  assert.deepEqual(JSON.parse(hingeNodesJson(analysis, [])), [], '显式 [] = 用户全不选，必须写空数组');
  assert.deepEqual(JSON.parse(hingeNodesJson(null, [])), []);
});

test('modelOf 把选中门节点写进 model.hingeNodesJson；不选也不能漏成 undefined', () => {
  const analysis = {
    picks: { size: { w: 600, d: 700, h: 800 } },
    doors: { found: [{ node: 'outer_door', expectAxis: 'y', angleDeg: 106 }] },
  };
  const m = modelOf({}, analysis, {});
  assert.equal(typeof m.hingeNodesJson, 'string', '后端读 model.hingeNodesJson（字符串），不能是数组');
  assert.deepEqual(JSON.parse(m.hingeNodesJson), [{ node: 'outer_door', axis: 'y', openAngleDeg: 106 }]);
  const none = modelOf({}, analysis, { doorNodes: [] });
  assert.deepEqual(JSON.parse(none.hingeNodesJson), [], '用户全不选时写空数组，不猜');
  const noModel = modelOf({}, null, {});
  assert.equal(noModel.hingeNodesJson, '[]', 'manual / 无分析也必须有这个字段');
});

/* ── B5/B6：加变体 / 人工代录（2026-09-30）──────────────────────────────
   三种入口的差别只在"走哪几步"和"提交哪个 payload"——都是纯计算，钉在这里。 */

test('三种入口的步骤集：create 三步含标注；variant/manual 保留确认步骤', () => {
  assert.deepEqual(orderOf('create'), ['basic', 'model', 'hotspots'], '确认摘要内嵌第 2 步，标注是第 3 步');
  assert.deepEqual(orderOf('variant'), ['model', 'confirm'], '产品是现成的 → 不重复录产品字段');
  assert.deepEqual(orderOf('manual'), ['basic', 'confirm'], '没有模型文件 → 没有可上传/可分析的东西');
  assert.deepEqual(orderOf('什么都不是'), ['basic', 'model', 'hotspots'], '认不得的模式退回完整流程');
});

test('加变体：只提交 model，且变体名写进 model.variant', () => {
  const m = modelOf({}, { picks: { size: { w: 600, d: 700, h: 800 } }, ok: true }, {});
  const p = variantPayload(m, 'v2');
  assert.deepEqual(Object.keys(p), ['model'], '接口只收 model（产品一个字段都不改）');
  assert.equal(p.model.variant, 'v2');
  assert.equal(p.model.bboxW, 600);
  assert.equal(p.model.unit, 'mm');
  assert.equal(variantPayload(m, '  v3  ').model.variant, 'v3', '两头空白要去掉');
});

test('变体名建议：跳过已占用的，且不用 v1（已有的叫 default）', () => {
  assert.equal(nextVariantName([]), 'v2');
  assert.equal(nextVariantName(['default']), 'v2');
  assert.equal(nextVariantName(['default', 'v2']), 'v3');
  assert.equal(nextVariantName(['default', 'v2', 'v3', 'v4']), 'v5');
});

test('人工代录：有产品、**没有 model**，且带齐声明尺寸与尺寸可信度', () => {
  const p = manualPayload({
    name: '代录款', modelNo: 'DEMO-FZ-25U', series: 'DW 系列',
    sizeNote: '官网图册估读，±20 mm', origin: '人工代录',
    w: 595, d: 610, h: 1750, doorPart: 'single', doorVerified: true,
  });
  assert.equal(p.model, undefined, '⭐ 没有 model：这是"代录"与"上传"的分界');
  assert.equal(p.product.origin, '人工代录', '来源要落库（库里一眼看出这不是供应商交的）');
  assert.equal(p.product.sizeNote, '官网图册估读，±20 mm');
  assert.equal(p.product.doorSource, 'admin', '代录的门型 = 维护端人工（V1 列注释里的 admin）');
  assert.equal(p.product.doorVerified, 1);
  const recipe = JSON.parse(p.product.recipeJson);
  assert.equal(recipe.w, 595);
  assert.equal(recipe.d, 610);
  assert.equal(recipe.h, 1750);
  assert.equal(recipe.id, 'demo-fz-25u', '目录 id 由型号 slug 化（进 URL 与缓存键）');
});

test('声明尺寸只认人工填：实测 bbox 不会静默变成声明', () => {
  const a = { picks: { size: { w: 600, d: 700, h: 800 } } };
  assert.deepEqual(dimsOf({}, a), { w: null, d: null, h: null },
    '没手填时不能拿分析器的实测 bbox 冒充声明');
  assert.deepEqual(dimsOf({ w: 1, d: 2, h: 3 }, a), { w: 1, d: 2, h: 3 }, '手填就是声明');
  assert.deepEqual(dimsOf({ w: 0 }, a), { w: null, d: null, h: null }, '0 / 负数不是尺寸');
  assert.deepEqual(declaredMissing({ w: 1, d: null, h: 3 }), [{ key: 'd', label: '深' }]);
  assert.equal(declaredSourceOf({ declaredSource: 'measured' }), 'measured');
  assert.equal(declaredSourceOf({}), 'manual');
});

test('新增产品：声明尺寸只从表单进 recipe；来源标记不冒充实测', () => {
  const p = buildPayload(
    { name: 'X', modelNo: 'DEMO-X', origin: '用户原始模型', w: 510, d: 520, h: 530 },
    { picks: { size: { w: 500, d: 600, h: 700 } }, ok: true },
    {});
  const recipe = JSON.parse(p.product.recipeJson);
  assert.deepEqual([recipe.w, recipe.d, recipe.h], [510, 520, 530], '不是分析器的 500/600/700');
  assert.equal('declaredSource' in p.product, false, '来源标记只属于界面，不混进 API 契约');
  assert.equal(p.product.origin, '用户原始模型');
  const measured = buildPayload(
    { name: 'X', modelNo: 'DEMO-X', w: 500, d: 600, h: 700, declaredSource: 'measured' },
    { picks: { size: { w: 1, d: 2, h: 3 } }, ok: true },
    {});
  assert.equal('declaredSource' in measured.product, false);
  assert.doesNotThrow(() => JSON.parse(measured.product.recipeJson));
});


test('第 1 步产品信息：门型/已确认/来源 admin 进 product，声明尺寸进 recipe', () => {
  const p = buildPayload(
    { name: 'X', modelNo: 'DEMO-X', description: 'D', doorPart: 'top', doorVerified: true, w: '510', d: '520', h: '530' },
    { picks: { size: { w: 500, d: 600, h: 700 }, door: { doorPart: 'single' } }, ok: true },
    {},
  );
  assert.equal(p.product.doorPart, 'top', '第 1 步人工选的门型是产品事实');
  assert.equal(p.product.doorVerified, 1);
  assert.equal(p.product.doorSource, 'admin');
  const recipe = JSON.parse(p.product.recipeJson);
  assert.deepEqual([recipe.w, recipe.d, recipe.h], [510, 520, 530], 'recipe 的 w/d/h 必须取 form');
  assert.equal(p.model.doorPart, 'top', '新手填的门型不应被分析器覆盖');
});

test('第2步的“门型已确认”没有门型时必须禁用（不许写没有依据的结论）', () => {
  const src = readFileSync(new URL('../src/admin/ProductWizard.vue', import.meta.url), 'utf8');
  assert.match(src, /:disabled="!form\.doorPart"[\s\S]{0,120}data-wz-step2-door-verified/);
  assert.match(src, /（未判断）/);
});

test('分析器拾到的门型也进 product.doorPart；没选门型时 doorVerified 不写 1', () => {
  const auto = buildPayload(
    { name: 'A', modelNo: 'M', description: 'D', doorVerified: true },
    { picks: { size: { w: 1, d: 2, h: 3 }, door: { doorPart: 'single' } } },
    {},
  );
  assert.equal(auto.product.doorPart, 'single', '分析器已识别时不能把产品门型丢掉');
  assert.equal(auto.product.doorVerified, 1);
  assert.equal(auto.model.doorPart, 'single');
  const noPart = buildPayload(
    { name: 'A', modelNo: 'M', description: 'D', doorVerified: true },
    { picks: { size: { w: 1, d: 2, h: 3 }, door: {} } },
    {},
  );
  assert.equal(noPart.product.doorVerified, 0, '没有门型时不能宣称已确认');
});

test('modelOf 带 thumbFile（分析器自动上传或手选覆盖都走 edits）', () => {
  const m = modelOf({}, { picks: { size: { w: 1, d: 2, h: 3 } } }, { thumbFile: '/api/thumbs/a.png' });
  assert.equal(m.thumbFile, '/api/thumbs/a.png');
  assert.equal(modelOf({}, null, {}).thumbFile, '', '没有缩略图时是空串，不伪造路径');
});

test('contentOf：卖点去空白、参数丢空行，简介不混进内容', () => {
  const c = contentOf({
    description: '简介属于 product',
    sellingPoints: ['  低温  ', '', '静音'],
    params: [
      { key: ' 容积 ', value: ' 510 ', unit: ' L ', group: '' },
      { key: '', value: 'x' },
    ],
  });
  assert.deepEqual(c, {
    sellingPoints: ['低温', '静音'],
    params: [{ key: '容积', value: '510', unit: 'L', group: '' }],
  });
  assert.deepEqual(contentOf(null), { sellingPoints: [], params: [] });
});

test('三步标签：第 1 步「维护基础信息」、第 2 步「模型结构识取」', () => {
  assert.equal(STEP_LABEL.basic, '维护基础信息');
  assert.equal(STEP_LABEL.model, '模型结构识取');
  assert.equal(STEP_LABEL.hotspots, '可视化标注');
});

test('向导第 1 步用 ProductContentFields；第 2 步自动缩略图/实测声明/门型确认；内容保存失败不静默', () => {
  const src = readFileSync(new URL('../src/admin/ProductWizard.vue', import.meta.url), 'utf8');
  assert.match(src, /import ProductContentFields from '\.\/ProductContentFields\.vue'/);
  assert.match(src, /<ProductContentFields\s+:content="form"/);
  assert.match(src, /维护基础信息/);
  assert.match(src, /模型结构识取/);
  assert.match(src, /analysis\.value\.picks\.thumb/);
  assert.match(src, /dataUrlToFile/);
  assert.match(src, /api\.adminUploadThumb/);
  assert.match(src, /edit\('thumbFile'/);
  assert.match(src, /data-wz-use-measured/);
  assert.match(src, /declaredFromMeasured\(form\.value, m\)/);
  assert.match(src, /edit\('envelopeMode', '1:1'\)/);
  assert.match(src, /data-wz-door-confirm/);
  assert.match(src, /api\.adminSaveProductContent\(dbId, \{ \.\.\.contentOf\(form\.value\), expectedRev: 0 \}\)/);
  assert.match(src, /产品已入库但产品信息保存失败，可重试/);
  assert.match(src, /step\.value = STEPS\.MODEL;[\s\S]*return;/);
});

/* ── 确认步的那几行（Part 2 的补断言）────────────────────────────────────
   为什么要在这儿钉：加变体那条路的确认步要**先把一个 GLB 分析完**才走得到，
   真机探针不在那里真传模型 —— 于是「加到哪款」「变体名」这两个最要紧的东西，
   只有这一层能兜住。（探针那边如实写着"这一段没走真机"，见 docs/42。） */

const FORM = { name: '立式低温保存箱', modelNo: 'DEMO-25L-2', description: '新增一份外观模型' };
const ANALYSIS = { picks: { size: { w: 700, d: 730, h: 850 }, door: { doorPart: 'single' }, envelope: { mode: 'fit' } } };
const shownOf = (k, v) => (v === undefined || v === null ? '—' : v);

test('确认步（加变体）：把「加到哪款」与「变体名」写出来 —— 这是探针走不到的那一处', () => {
  const rows = confirmRows({
    mode: 'variant', form: FORM, analysis: ANALYSIS, edits: {},
    productId: 7, productLabel: 'DEMO-25L-2 · 立式低温保存箱', variantName: 'v2',
    sourcePath: 'uploads/a.glb', doorLabel: '单门',
    shown: shownOf,
  });
  const by = (label) => rows.find((r) => r.label === label);
  assert.ok(by('加到哪款'), '要有「加到哪款」这一行，否则用户不知道模型加到了哪一款上');
  assert.ok(by('加到哪款').value.includes('#7'), by('加到哪款').value);
  assert.ok(by('加到哪款').value.includes('DEMO-25L-2'), by('加到哪款').value);
  assert.ok(by('变体名'), '要有「变体名」这一行');
  assert.equal(by('变体名').input, true, '变体名要是个输入框（不是只读文字）');
  assert.equal(by('变体名').required, true, '变体名必填（重名服务端会 409）');
  assert.equal(by('变体名').value, 'v2');
  assert.equal(by('尺寸（mm）').value, '700 × 730 × 850');
  assert.ok(!rows.some((r) => r.label === '来源'), '加变体不该出现「来源」（那是代录的事）');
});

test('确认步（新增产品）：不该出现变体名与加到哪款（同一张表按模式给行）', () => {
  const rows = confirmRows({
    mode: 'create', form: FORM, analysis: ANALYSIS, edits: {},
    productId: null, productLabel: '', variantName: '', sourcePath: 'uploads/a.glb',
    doorLabel: '单门', shown: shownOf,
  });
  assert.ok(!rows.some((r) => r.label === '变体名'), '新增产品没有变体名');
  assert.ok(!rows.some((r) => r.label === '加到哪款'), '新增产品没有"加到哪款"');
  assert.ok(rows.some((r) => r.label === '源文件'));
});

test('确认步（人工代录）：来源 / 声明尺寸 / 尺寸备注，并明说「没有模型文件」', () => {
  const rows = confirmRows({
    mode: 'manual',
    form: { name: 'X', modelNo: 'DEMO-1', description: '供应商没交模型', origin: '人工代录', w: '900', d: '800', h: '1900', sizeNote: '按厂家规格书抄的', doorPart: 'double', doorVerified: true },
    analysis: null, edits: {}, shown: shownOf,
  });
  const by = (label) => rows.find((r) => r.label === label);
  assert.equal(by('来源').value, '人工代录', '来源要写出来（库里靠它分清"没跑完"与"本来就没有"）');
  assert.equal(by('声明尺寸（mm）').value, '900 × 800 × 1900');
  assert.ok(by('尺寸备注').value.includes('规格书'));
  assert.ok(by('门型').value.includes('已确认'));
  assert.ok(by('模型文件').value.includes('没有'), '代录最容易被误读的就是这一点，必须写出来');
  assert.ok(!rows.some((r) => r.label === '尺寸对账'), '代录没有分析结果，不该出现"尺寸对账"');
});

test('确认步：每一行都要有标签（空标签在界面上就是个空壳）', () => {
  for (const mode of ['create', 'variant', 'manual']) {
    const rows = confirmRows({ mode, form: FORM, analysis: ANALYSIS, edits: {}, shown: shownOf });
    assert.ok(rows.length >= 4, mode + ' 的行数太少：' + rows.length);
    for (const r of rows) {
      assert.ok(String(r.label || '').trim().length > 0, mode + ' 里有空标签的行：' + JSON.stringify(r));
    }
  }

});

// ── 两条模型判据（批 3：dev-1 / dev-2 / dev-5）─────────────────────────────
//
// 这两条以前都是"永远不会红"的判据：
//   `envelope_ok` 写入侧判 5%（单位容差）、读出侧角标判 1 mm（对账）→ 角标永不出现；
//   `anisotropy_ok` 根本没被提交过（后端缺键取 1）→「缩放不均匀」永不出现。
// 这里用审查报告里那两个**具体数字**钉住：声明 990×1980×871 vs 实测 970×1950×860。

test('尺寸对账：1:1 必须逐轴 1 mm —— 差 20/30/11 mm 就是没对上账', () => {
  const declared = { w: 990, h: 1980, d: 871 };
  const measured = { w: 970, h: 1950, d: 860 };
  assert.equal(envelopeOkFor('1:1', measured, declared), 0, '差 20/30/11 mm 不许算对上了');
  // 边界：1 mm 以内算对上（读出侧角标文案写的就是"差 > 1 mm"）—— 两边必须是同一件事
  assert.equal(envelopeOkFor('1:1', { w: 989, h: 1980, d: 871 }, declared), 1);
  assert.equal(envelopeOkFor('1:1', { w: 988.9, h: 1980, d: 871 }, declared), 0, '1.1 mm 也要报');
  // 还没填声明尺寸 → **未判**（null），不是"通过"
  assert.equal(envelopeOkFor('1:1', measured, { w: null, h: null, d: null }), null);
  assert.equal(envelopeOkFor(null, measured, declared), null);
});

test('尺寸对账：fit 只拦单位错（口径保持不变，别把两件事混成一个字段）', () => {
  const declared = { w: 990, h: 1980, d: 871 };
  // 现有 4 个型号都是这一类：实测 525.5×990×517 vs 声明 990×1980×871 —— 好模型，不是毛病
  assert.equal(envelopeOkFor('fit', { w: 525.5, h: 990, d: 517 }, declared), 1);
  // 单位错（实测是声明的 1000 倍 / 千分之一）→ 0，这一条是硬的
  assert.equal(envelopeOkFor('fit', { w: 990000, h: 1980000, d: 871000 }, declared), 0);
  assert.equal(envelopeOkFor('fit', { w: 0.99, h: 1.98, d: 0.871 }, declared), 0);
});

test('缩放不均匀：算得出来给 0/1，算不出来给 null（未判 ≠ 均匀）', () => {
  const declared = { w: 990, h: 1980, d: 871 };
  // 三轴等比缩放 → 1
  assert.equal(anisotropyOf({ w: 495, h: 990, d: 435.5 }, declared).ok, 1);
  // 某轴被拉伸（宽 0.53 / 高 0.50 / 深 0.59）→ 0
  assert.equal(anisotropyOf({ w: 525.5, h: 990, d: 517 }, declared).ok, 0);
  assert.ok(anisotropyOf({ w: 525.5, h: 990, d: 517 }, declared).ratio > 1.15);
  // 没声明尺寸 → null。**这一格以前会被写成 1（替模型宣称"比例正常"）**，是 dev-1 的核心
  assert.equal(anisotropyOf({ w: 525.5, h: 990, d: 517 }, { w: null, h: null, d: null }).ok, null);
});

test('阈值只有一处：来自参数表 model.anisotropyWarn（默认 1.02）', () => {
  const declared = { w: 1000, h: 1000, d: 1000 };
  assert.equal(anisotropyOf({ w: 1000, h: 1015, d: 1015 }, declared).ok, 1, '1.015 < 1.02 → 均匀');
  assert.equal(anisotropyOf({ w: 1000, h: 1030, d: 1030 }, declared).ok, 0, '1.03 > 1.02 → 不均匀');
});

/* 第 3 轮审查 C-10：1:1 的对账容差原来写着三个数（写入侧 1 mm、维护端角标文案 1 mm、
   设计端 scene3d.js 5 mm）。声明 990 / 实测 994.5 的模型在维护端挂「尺寸未对账」、
   在设计端却报合格 —— 同一个模型两处相反结论，违反 `AGENTS.md` §5。
   现在容差只有一处出处：参数表 `model.envelopeTolMm`（默认 1 mm，读法 `envelopeTolMm()`）。 */
test('1:1 的容差是 1 mm：差 4.5 mm 必须判「未对账」（与维护端同一个结论）', () => {
  const declared = { w: 990, h: 1980, d: 871 };
  assert.equal(envelopeOkFor('1:1', { w: 994.5, h: 1980, d: 871 }, declared), 0,
    '差 4.5 mm > 1 mm → 0。设计端以前写死 5 mm，这一格会算成 1（C-10）');
  assert.equal(envelopeOkFor('1:1', { w: 991, h: 1980, d: 871 }, declared), 1,
    '差正好 1 mm → 及格（判据是 ≤ 不是 <）');
});

test('对账容差必须挂在实际用到它的两个文件上（不许再写死数字）', () => {
  const analysis = readFileSync(new URL('../src/admin/analyze.js', import.meta.url), 'utf8');
  const scene = readFileSync(new URL('../src/scene3d.js', import.meta.url), 'utf8');
  // ⚠️ 必须认**代码形状**，不能只 `includes('envelopeTolMm()')` —— 注释里也会提这个名字，
  //    那样把 `const tolMm = 5;` 改回去照样能过（当场变异验证过：第一版就是这么被骗过去的）。
  assert.ok(/<=\s*envelopeTolMm\(\)/.test(analysis),
    'analyze.js 的 1:1 判据没读参数表里的对账容差（第 3 轮审查 C-10）');
  assert.ok(/const\s+tolMm\s*=\s*envelopeTolMm\(\)/.test(scene),
    'scene3d.js 的容差不是从参数表取的（C-10：设计端与维护端必须是同一把尺子）');
  assert.ok(!/[\.][\.][\.]deltas\)\s*<=\s*\d/.test(scene),
    'scene3d.js 的加载体检又写死了数字容差（C-10 复发）');
});

test('判据必须真的挂在 modelOf 上（漏挂 = 后端又回到"缺键取 1"）', () => {
  const model = modelOf({ w: 990, h: 1980, d: 871, name: 'x', modelNo: 'x' },
    { mm: { w: 970, h: 1950, d: 860 }, picks: { envelope: { mode: '1:1' } } }, {});
  assert.equal(model.envelopeMode, '1:1');
  assert.equal(model.envelopeOk, 0, '1:1 差 20/30/11 mm → 必须 0');
  assert.ok('anisotropyOk' in model, 'anisotropyOk 必须在 payload 里（以前根本没有这个键）');
  // 没填声明尺寸 → 两条都是 null（未判），后端写 NULL —— 不许假装判过
  const noDecl = modelOf({ name: 'x', modelNo: 'x' },
    { mm: { w: 970, h: 1950, d: 860 }, picks: { envelope: { mode: '1:1' } } }, {});
  assert.equal(noDecl.envelopeOk, null);
  assert.equal(noDecl.anisotropyOk, null);
});

/* 这一条是**源码级的钉子**（不是运行时证明）—— node 里没有 DOM/WebGL，落地测不了；
   运行时那一面靠浏览器自己的告警（Too many active WebGL contexts）去看。
   钉它的理由：`renderModel()` 每调一次就新建一个渲染器，而 `dispose()` **不会**把上下文还给
   浏览器 —— 这一行被拿掉不会有任何报错，只会让维护端翻一遍列表就攢下一撑上下文
   （核显的显存与系统内存共用，挤的是可用内存）。规矩本身写在 `scene3d.js` 的 B18 注释里。 */
test('缩略图渲染要归还 WebGL 上下文：forceContextLoss 必须在 dispose 之前', () => {
  const src = readFileSync(new URL('../src/admin/analyze.js', import.meta.url), 'utf8');
  const start = src.indexOf('function renderModel');
  assert.ok(start > 0, 'analyze.js 里找不到 renderModel —— 钉子钉的是那个函数的 finally，先确认它还在');
  const tail = src.slice(start);
  const finIdx = tail.indexOf('} finally {');
  assert.ok(finIdx > 0, 'renderModel 里找不到 finally');
  const finBlock = tail.slice(finIdx, tail.indexOf('\n  }', finIdx));
  // 认**真正的调用形式**（带 renderer?.），不然注释里提到的 dispose() 会把顺序看反
  const fc = finBlock.indexOf('renderer?.forceContextLoss()');
  const dp = finBlock.indexOf('renderer?.dispose()');
  assert.ok(fc > 0, 'renderModel 的 finally 里没有 forceContextLoss() —— 每渲染一张图就漏一个上下文（B18）');
  assert.ok(dp > 0, 'renderModel 的 finally 里没有 dispose()');
  assert.ok(fc < dp, 'forceContextLoss() 必须在 dispose() 之前（顺序反了等于没还）');
});
test('submit 成功后的第 3 步闸门：只有新增产品且拿到 dbId 才进标注', () => {
  assert.equal(canOpenHotspotBoard('create', { dbId: 12 }), true);
  assert.equal(canOpenHotspotBoard('create', { dbId: null }), false);
  assert.equal(canOpenHotspotBoard('create', null), false);
  assert.equal(canOpenHotspotBoard('variant', { dbId: 12 }), false, '加变体不硬塞看板');
  assert.equal(canOpenHotspotBoard('manual', { dbId: 12 }), false, '人工代录没有模型');
});

test('create 主 CTA 直接进 step3，删掉可选看板/独立 confirm 的死流程', () => {
  const src = readFileSync(new URL('../src/admin/ProductWizard.vue', import.meta.url), 'utf8');
  assert.match(src, /data-cta-hotspots/);
  assert.match(src, /@click="submitAndAnnotate"/);
  assert.match(src, /step\.value = STEPS\.HOTSPOTS/);
  assert.match(src, /确认入库并进入标注/);
  assert.match(src, /只传 1 个源 GLB/);
  assert.match(src, /hingeNodesJson/);
  assert.match(src, /analysis\.doors/);
  assert.match(src, /@back="backFromBoard"/);
  assert.doesNotMatch(src, /boardOpen/, '验收-3 不再有可选 boardOpen 状态');
  assert.doesNotMatch(src, /data-board-open/, '不再留“继续标注（可选）”死按钮');
  assert.doesNotMatch(src, /@click="openBoard"/);
  assert.match(src, /step\.value = order\.value\[i - 1\]/);
  assert.doesNotMatch(src, /step\.value = ORDER\[i - 1\]/);
});
