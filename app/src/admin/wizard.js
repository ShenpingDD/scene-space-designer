/**
 * wizard.js —— 三步向导的纯计算（R6-2 Step 3）
 *
 * 为什么单独抽文件（照 view.js 的既有做法）：向导的真值不是界面，而是
 * 「这一步能不能过、每个自动值的依据是什么、payload 拼得对不对」——
 * 这三件事都要能在 node 里被单测钉住，而不是散在组件的 computed 里「看起来对」。
 *
 * 三条来自 docs/32 §2.2 的硬规矩，构成这个文件的骨架：
 *   1. 自动化是**默认值**，不是最终值 —— 每个 picks 项都能被人工改掉
 *   2. 不给依据的自动值 = 让人选择不信 —— 每项都带 evidence + confidence
 *   3. 机器不敢猜就直说 —— picked=null 不许被一个 0 置信度的值冒充
 */

import { envelopeOkFor, anisotropyOf } from './analyze.js';

// 验收-3：新增产品只走 basic → model → hotspots；model 页内嵌确认摘要与入库 CTA。
// variant / manual 仍保留一个 confirm 步骤（它们没有“第 3 步标注”这条路）。
export const STEPS = { BASIC: 'basic', MODEL: 'model', CONFIRM: 'confirm', HOTSPOTS: 'hotspots' };
export const ORDER = [STEPS.BASIC, STEPS.MODEL, STEPS.HOTSPOTS];

// ── 三种入口（B5/B6）─────────────────────────────────────────────
// create  = 供应商给了 GLB，走完三步（R6-2 那条路）
// variant = 给**已有产品**加一份模型（决策④：换模型 = 新增 variant，不覆盖）→ 不需要产品那一步
// manual  = 人工代录（决策⑨：供应商未按规范交）→ **没有模型文件**，不需要上传/分析那一步
// 步骤集按模式算，而不是在模板里写三套分支：不可达的步骤自然就不渲染。
export const MODE = { CREATE: 'create', VARIANT: 'variant', MANUAL: 'manual' };
export const MODE_LABEL = {
  create: '新增产品',
  variant: '加一个变体',
  manual: '人工代录',
};

/**
 * 提交成功之后能不能进入第 3 步（可视化标注）。
 * 只有「新增产品」且有 dbId 才有可标的产品；人工代录没有模型，加变体是给已有产品换模型，
 * 都不该在这里硬塞一个空看板。纯函数，测试可钉。
 *
 * 名字保留 `canOpenHotspotBoard` 是为了让旧调用点/测试一眼能搜到；
 * 验收-3 起它不再控制“可选看板”，而是 submit 成功后切到 step 3 的闸门。
 */
export function canOpenHotspotBoard(mode, receipt) {
  return mode === MODE.CREATE && !!receipt && receipt.dbId != null && receipt.dbId !== '';
}

export function orderOf(mode) {
  if (mode === MODE.VARIANT) return [STEPS.MODEL, STEPS.CONFIRM];
  if (mode === MODE.MANUAL) return [STEPS.BASIC, STEPS.CONFIRM];
  return ORDER;
}
/** 步骤名只写“做什么”，第几步由当前模式的 order 在界面里算。 */
export const STEP_LABEL = {
  basic: '维护基础信息',
  model: '模型结构识取',
  confirm: '确认入库',
  hotspots: '可视化标注',
};

/** 第 1 步的必填项。**每条都带落库位置**，报错时直接能读懂。 */
export const REQUIRED_BASIC = [
  { key: 'name', label: '产品名称', why: '落 product.name' },
  { key: 'modelNo', label: '产品型号', why: '落 product.model_no —— 目录种子、方案数据、供应商对账三处的共同锚点' },
  { key: 'description', label: '产品简介', why: '落 product.description' },
];

/**
 * 第 1 步校验。**一次报出全部缺失**（只报第一个会让用户来回改十几遍）。
 * @returns {{ok: boolean, missing: Array<{key:string,label:string,why:string}>}}
 */
export function validateBasic(form) {
  const f = form || {};
  const missing = REQUIRED_BASIC.filter((r) => !String(f[r.key] == null ? '' : f[r.key]).trim());
  return { ok: missing.length === 0, missing };
}

/** 型号归一化：撞号判断不能因为空格/大小写放过两个人填的同一个型号。 */
export function normalizeModelNo(s) {
  return String(s == null ? '' : s).trim().toUpperCase();
}

/** 型号是否已被占用（拿现有产品列表比，**不靠后端 400 才知道**）。 */
export function modelNoTaken(products, modelNo) {
  const want = normalizeModelNo(modelNo);
  if (!want) return false;
  const list = Array.isArray(products) ? products : [];
  return list.some((p) => p && normalizeModelNo(p.modelNo) === want);
}

/** 一个 picks 项 → 一行「可改的表」。**字段名带单位**（本项目铁律：单位写进名字）。 */
function pickRow(key, label, item, note) {
  const it = item || {};
  return {
    key,
    label,
    auto: !!it.auto,
    confidence01: typeof it.confidence === 'number' ? it.confidence : 0,
    evidence: it.evidence || '',
    humanRequired: !!it.humanRequired,
    note: note || '',
  };
}

/**
 * 把分析器的 picks 摊成可渲染的行。**顺序照 docs/32 §2.2 那张图**。
 * 每一项都带：是否自动 / 置信度(0-1) / 依据 / 是否必须人工确认。
 */
export function pickRows(analysis) {
  const p = (analysis && analysis.picks) || {};
  const rows = [
    pickRow('thumb', '缩略图', p.thumb),
    pickRow('size', '尺寸（mm）', p.size),
    pickRow('topView', '顶视图', p.topView),
    pickRow('envelope', '尺寸对账', p.envelope),
    pickRow('front', '正对面', p.front),
    pickRow('door', '门型', p.door),
  ];
  // ② 规矩：机器不敢猜就直说 —— 不许让一个 0 置信度的值冒充答案
  const front = p.front || {};
  if (front.picked == null) rows[4].note = '机器不敢猜（模型里没有能提供方位信息的门），请人工指定';
  const env = p.envelope || {};
  if (env.mode == null) rows[3].note = '没有声明尺寸可比 —— 判不了 1:1 还是 fit，需人工确认';
  return rows;
}

/** 体检结论按严重度分组。**bad 才拦人**（warn 只是提醒，见 analyze.js 的 ok 口径）。 */
export function checkSummary(checks) {
  const list = Array.isArray(checks) ? checks.filter(Boolean) : [];
  const of = (lv) => list.filter((c) => c.level === lv);
  return { bad: of('bad'), warn: of('warn'), ok: of('ok'), total: list.length };
}

/**
 * 第 2 步能不能放行。
 * 规矩：**缺门节点不拦人**（docs/32 §2.2 明文：门型降级为人工选，不是拒绝入库）；
 * 只有 level=bad 的体检项才拦。
 */
/**
 * 声明包络（recipe_json 的 w/d/h，单位 mm）——**前台的占地读的就是它**（见 DbCatalog.shapeProduct）。
 *
 * 为什么单拎出来：分析出来的尺寸一直只进了 `product_model.bbox_*`（实测），
 * 而目录读的是 `recipe_json.w/d/h`（声明）—— **两边不是同一份数据**。
 * 于是向导建出来的产品会因“没有声明占地”进不了目录（服务端只会 log.warn，界面上悄无声息）。
 * 人工代录更必须有它：那种产品**没有模型行**，占地只能靠声明值。
 */
export function dimsOf(form) {
  const f = form || {};
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // 声明尺寸只能来自**人工填写**。分析器给的是实测 bbox，它可以用来校准，
  // 但绝不能静默变成声明值 —— 那会让“声明的占地”和“模型实测”互为自证。
  return { w: num(f.w), d: num(f.d), h: num(f.h) };
}

/** 声明三轴缺了哪几个。提交前必须逐轴指出来，不允许“自动补一个”。 */
export function declaredMissing(form) {
  const d = dimsOf(form);
  const labels = { w: '宽', d: '深', h: '高' };
  return ['w', 'd', 'h'].filter((k) => d[k] == null).map((k) => ({ key: k, label: labels[k] }));
}

/** 声明尺寸来源：measured = 用户点了“用实测尺寸作为声明”；manual = 手填。 */
export function declaredSourceOf(form) {
  return form && form.declaredSource === 'measured' ? 'measured' : 'manual';
}

/** 人工确认动作：把三轴实测值一次性写成声明，并留下 measured 来源。 */
export function declaredFromMeasured(form, measured) {
  const out = { ...(form || {}) };
  for (const k of ['w', 'd', 'h']) {
    const n = Number(measured && measured[k]);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  out.declaredSource = 'measured';
  return out;
}

/**
 * 模型那一半的 payload —— 新增产品与“加一个变体”**共用这一处**（两处各拼一遍，迟早漏字段）。
 */
export function modelOf(form, analysis, edits) {
  const f = form || {};
  const a = analysis || {};
  const p = a.picks || {};
  const e = edits || {};
  const unit = 'mm';
  // 口径随 mode 变（envelope_ok 的判据因此必须在这里算，不能直接用分析结果里的 a.ok）
  const mode = e.envelopeMode !== undefined ? e.envelopeMode : (p.envelope ? p.envelope.mode : null);
  return {
    sourceFilePath: e.sourceFilePath !== undefined ? e.sourceFilePath : (f.sourceFilePath || ''),
    // 分析器渲出的缩略图由第 2 步上传后放进 edits.thumbFile；手选图片也走这里。
    thumbFile: e.thumbFile !== undefined ? e.thumbFile : (f.thumbFile || ''),
    bboxW: e.bboxW !== undefined ? e.bboxW : (p.size ? p.size.w : null),
    bboxD: e.bboxD !== undefined ? e.bboxD : (p.size ? p.size.d : null),
    bboxH: e.bboxH !== undefined ? e.bboxH : (p.size ? p.size.h : null),
    // ⚠️ 这里**必须叫 `unit`**，不要另起名字。
    //    后端读的是 model.unit（ProductDraft.validate、ProductWriteRepository 的 :unit），
    //    分析器自己的 bbox 也用 unit —— 而**全项目只有这一个地方**给同一样东西换过名字，
    //    于是端到端实测时后端回「缺 unit」，ApiAdvice 的 500 兜底又把它说成
    //    「服务端内部错误」，从界面完全看不出是少了一个字段。
    //    同一个东西有两个名字，就是这类错的标准长相。
    unit,
    // 第 1 步人工选的門型是产品事实；没选才回落到分析器拾取值。
    doorPart: e.doorPart !== undefined ? e.doorPart : (f.doorPart || (p.door ? p.door.doorPart : null)),
    // 验收-3：把第 2 步勾选的门节点写到后端已支持的 model.hingeNodesJson；
    // 这是新增字段，不改迁移。不传 e.doorNodes 时保留分析器的全选默认。
    hingeNodesJson: e.hingeNodesJson !== undefined
      ? e.hingeNodesJson : hingeNodesJson(a, e.doorNodes),
    envelopeMode: mode,
    // ⚠️ 两条判据都必须**当场算**（第 2 轮审查 dev-1/dev-2）：
    //    `envelopeOk: a.ok ? 1 : 0` 是把"没有任何 bad 级体检项"当成了"尺寸对过账" ——
    //    两件不同的事，而且**它永远算不出 0**（缺声明尺寸时体检本来就不会报 bad）。
    //    声明尺寸只认**人工填的**（实测 bbox 只能校准，不能自证成声明）。
    envelopeOk: envelopeOkFor(mode, a.mm, declaredByHuman(f)),
    anisotropyOk: anisotropyOf(a.mm, declaredByHuman(f)).ok,
  };
}

/**
 * 分析器 doors.found → 可确认的门节点行。
 *
 * 分析器给的是 `expectAxis` / `angleDeg`（来自节点 extras.hinge），而库里
 * `product_model.hinge_nodes` 与设计端吃的是 `{node, axis, openAngleDeg}`。
 * 这里做**唯一一次**口径转换，别让模板自己拼 JSON。
 */
export function doorOptionsOf(analysis) {
  const found = (analysis && analysis.doors && analysis.doors.found) || [];
  return found.map((d) => {
    // Number(null) === 0：不先把 null 挡住，会把“模型没标开角”写成 0°。
    const rawAngle = d && d.angleDeg;
    const angle = rawAngle == null || rawAngle === '' ? null : Number(rawAngle);
    const pivotRaw = d && d.pivotMm;
    const pivotMm = Array.isArray(pivotRaw) && pivotRaw.length === 3
      ? pivotRaw.map(Number) : null;
    const hasPivot = !!pivotMm && pivotMm.every(Number.isFinite);
    // hingeAxis 可能是 [0,-1,0]：正的 openDirection 绕反向轴 = 负向旋转，
    // 这里统一折算成"绕 +axis 的符号"，后续只认 openDirection。
    const dirRaw = (d && (d.openDirection || d.dir)) || null;
    const axisSign = d && d.axisSign === -1 ? -1 : 1;
    const dirSign = (dirRaw === '-' ? -1 : 1) * axisSign;
    return {
      node: String((d && d.node) || ''),
      axis: String((d && (d.expectAxis || d.axis)) || 'y'),
      openAngleDeg: Number.isFinite(angle) ? angle : 106,
      angleFromModel: Number.isFinite(angle),
      part: String((d && d.part) || ''),
      specCompliant: !!(d && d.specCompliant),
      side: (d && d.side) || null,
      // 真实铰链点（模型局部 mm）与开门方向：有就往下传，没有就是 null，不伪造
      pivotMm: hasPivot ? pivotMm : null,
      openDirection: dirRaw == null ? null : (dirSign < 0 ? '-' : '+'),
    };
  }).filter((d) => d.node);
}

/**
 * 选中门节点 → `hingeNodesJson`。
 * selected 省略 = 全选（分析器扫到的都作为默认值）；显式 [] = 用户全不选。
 * 有可靠铰链点（模型 extras 的 hingePoint）时附带 pivotMm/openDirection；
 * 没有就仍只写 node/axis/openAngleDeg —— 旧数据/旧测试的形状不变。
 */
export function hingeNodesJson(analysis, selected) {
  const all = doorOptionsOf(analysis);
  const want = Array.isArray(selected) ? new Set(selected.map(String)) : null;
  const list = want ? all.filter((d) => want.has(d.node)) : all;
  return JSON.stringify(list.map((d) => {
    const row = {
      node: d.node,
      axis: d.axis,
      openAngleDeg: d.openAngleDeg,
    };
    if (d.pivotMm) row.pivotMm = d.pivotMm;
    if (d.openDirection) row.openDirection = d.openDirection;
    return row;
  }));
}

/** 人工填的声明尺寸（**不退回实测值** —— 拿实测当声明去"对账"是自证清白）。 */
function declaredByHuman(f) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return { w: num(f && f.w), h: num(f && f.h), d: num(f && f.d) };
}

/** 加变体：接口只收 `model`（产品行是现成的、一个字段都不改） */
export function variantPayload(model, variantName) {
  return { model: { ...(model || {}), variant: String(variantName || '').trim() } };
}

/**
 * 变体名的**建议值**（只是建议 —— 最终由服务端的唯一键裁决，重名会回 409 并列出已有的）。
 * 不用 `v1`：已有的叫 `default`，从 `v2` 起数最不容易撞。
 */
/**
 * 「确认」那一步要显示的那几行（**纯函数** —— 界面里零业务判断，这里也一样）。
 *
 * 抽它出来的直接原因：加变体那条路的确认步**真机探针走不到**（要先把一个 GLB 分析完），
 * 而那一步上恰好写着两件最要紧的事 ——「加到哪款」与「变体名」。
 * 抽成纯函数之后它们可以被断言；探针那边则如实写明"这一段没走真机"（见 docs/42）。
 *
 * 三种模式各有一套行（这也是判据的一部分）：
 *   · `create`  —— 有模型：名称/型号/尺寸/对账/门型/源文件（**不该出现变体名**）
 *   · `variant` —— 有模型：同上 + **加到哪款** + **变体名（必填）**
 *   · `manual`  —— 没模型：名称/型号/来源/「声明尺寸」/尺寸备注/门型 + "模型文件：没有"
 * ⚠️ 这个注释的第一版在「加粗」紧贴着斜杠的地方（`**声明尺寸**` 后面紧跟一个撇杠）拼出了注释结束符，
 *    于是注释在那儿被提前结束、后面几行成了代码（`Unexpected token`）。写注释时别让加粗紧贴着斜杠。
 *
 * `shown(key, fallback)` 由调用方给（界面里那份是"人工改动优先、其次分析值"）。
 * 传进来而不是在这里再算一遍：那份"谁优先"的口径只能有一处。
 */
export function confirmRows(o) {
  const opts = o || {};
  const form = opts.form || {};
  const analysis = opts.analysis || null;
  const edits = opts.edits || {};
  const shown = typeof opts.shown === 'function' ? opts.shown : (_k, v) => v;
  const rows = [
    { label: '名称', value: form.name || '' },
    { label: '型号', value: form.modelNo || '', mono: true },
    { label: '简介', value: form.description || '' },
  ];

  if (opts.mode === MODE.MANUAL) {
    rows.push({ label: '来源', value: form.origin || '' });
    rows.push({
      label: '声明尺寸（mm）',
      value: `${form.w || '?'} × ${form.d || '?'} × ${form.h || '?'}`,
      mono: true,
    });
    rows.push({ label: '尺寸备注', value: form.sizeNote || '' });
    rows.push({
      label: '门型',
      value: (form.doorPart || '（未确认）') + (form.doorVerified ? ' · 已确认' : ''),
    });
    // 代录最容易被后人误读的就是"为什么它没有模型"—— 所以这一行必须写得明明白白
    rows.push({
      label: '模型文件',
      value: '没有 —— 代录的就是这个：占地靠上面的声明尺寸，三维模型以后补',
      muted: true,
    });
    return rows;
  }

  // 两条"有模型"的路（新增 / 加变体）：尺寸、对账、门型来自**分析结果**（人工改动优先）
  const picks = (analysis && analysis.picks) || { size: {}, envelope: {}, door: {} };
  rows.push({
    label: '尺寸（mm）',
    value: `${shown('bboxW', picks.size.w)} × ${shown('bboxD', picks.size.d)} × ${shown('bboxH', picks.size.h)}`,
    mono: true,
  });
  rows.push({ label: '门型', value: opts.doorLabel || '（未指定）' });
  rows.push({ label: '尺寸对账', value: shown('envelopeMode', picks.envelope.mode) || '（未判）' });
  rows.push({ label: '源文件', value: opts.sourcePath || '', mono: true });

  if (opts.mode === MODE.VARIANT) {
    // ⭐ 这两行就是"补上那一处断言"要钉住的东西
    rows.push({
      label: '加到哪款',
      value: `#${opts.productId} ${opts.productLabel || ''}`.trim(),
    });
    rows.push({
      label: '变体名',
      value: opts.variantName || '',
      input: true,
      required: true,
      note: '重名会被服务端拦下（409）并列出已有的 —— 那时换个名字就行',
    });
  }
  if (Object.keys(edits).length) {
    rows.push({ label: '人工改动', value: Object.keys(edits).join('、') });
  }
  return rows;
}

export function nextVariantName(variants) {
  const used = new Set((variants || []).map((v) => String(v)));
  for (let i = 2; i < 100; i++) {
    if (!used.has('v' + i)) return 'v' + i;
  }
  return 'v100';
}

/**
 * 人工代录（决策⑨）：有产品、**没有模型**。
 *
 * 服务端看到 `model` 缺失会走**更严的**那套判据（来源必须是「人工代录」+ 尺寸可信度必填 +
 * 声明尺寸 w/d/h 必须有）—— 所以这里不是“少写几条”，而是换了一条判据。
 */
export function manualPayload(form) {
  const f = form || {};
  const d = dimsOf(f, null);
  const product = {
    name: String(f.name || '').trim(),
    modelNo: String(f.modelNo || '').trim(),
    description: String(f.description || '').trim(),
    series: String(f.series || '').trim(),
    color: String(f.color || '').trim(),
    sizeNote: String(f.sizeNote || '').trim(),
    sourceUrl: String(f.sourceUrl || '').trim(),
    origin: String(f.origin || '').trim(),
    // 门型是**产品事实**（不从几何推）：代录时由人指定，来源记 admin（维护端人工，见 V1 列注释）
    doorPart: f.doorPart || null,
    doorVerified: f.doorVerified && f.doorPart ? 1 : 0,
    doorSource: 'admin',
    recipeJson: JSON.stringify({
      id: f.recipeId || slugify(f.modelNo),
      modelNo: String(f.modelNo || '').trim(),
      name: String(f.name || '').trim(),
      unit: 'mm',
      ...d,
    }),
    status: 'draft',
  };
  return { product, notes: Array.isArray(f.notes) ? f.notes : [] };
}

/** “能不能进下一步（浏览器里那些自动拾取的结果合不合格）”—— 与后端的判据**不是同一件事**：
 *  这里管的是“分析结果里有没有拦下的项”，后端管的是“落库要求的字段全不全”。 */
export function canSubmit(analysis) {
  if (!analysis) return { ok: false, blockers: ['还没有分析过模型'] };
  const s = checkSummary(analysis.checks);
  return { ok: s.bad.length === 0, blockers: s.bad.map((c) => c.text || c.key) };
}

/**
 * 组装提交 payload，形状与后端 `POST /api/admin/products` 逐字对应：
 *   { product: {name, modelNo, description, ..., recipeJson}, model: {...}, notes: [...] }
 *
 * `edits` 是人工改过的值（key → 值）；**没改的用自动值**。
 * 这里**不做静默回退**：如果人工把门型清空了，就原样传 undefined，让后端/界面去说，
 * 而不是悄悄塞一个自动值回去。
 */
export function buildPayload(form, analysis, edits) {
  const f = form || {};
  const e = edits || {};   // 产品那一半仍要看人工改动（颜色等），模型那一半在 modelOf 里看
  const d = dimsOf(f, analysis);
  // 门型是产品事实：第 1 步没选时，允许采用分析器拾到的值（仍要人勾「已确认」）。
  // 不能只从 f.doorPart 取：分析器已经识别出门型时，用户在第 2 步看到的摘要就是它，
  // 若这里丢掉，会出现“看板显示柜门，库里 door_part 为空”的假数据。
  const pickedDoor = analysis && analysis.picks && analysis.picks.door
    ? analysis.picks.door.doorPart : null;
  const doorPart = e.doorPart !== undefined ? e.doorPart : (f.doorPart || pickedDoor || null);
  const doorVerified = f.doorVerified && doorPart ? 1 : 0;
  const product = {
    name: String(f.name || '').trim(),
    modelNo: String(f.modelNo || '').trim(),
    description: String(f.description || '').trim(),
    series: String(f.series || '').trim(),
    color: e.color !== undefined ? e.color : (f.color || ''),
    sizeNote: String(f.sizeNote || '').trim(),
    sourceUrl: String(f.sourceUrl || '').trim(),
    origin: String(f.origin || '').trim(),
    // 门型是产品事实：维护端在第 1 步选/确认，来源固定 admin（见 V1 的 door_source 注释）。
    doorPart,
    doorVerified,
    doorSource: 'admin',
    recipeJson: JSON.stringify({
      id: f.recipeId || slugify(f.modelNo),
      modelNo: String(f.modelNo || '').trim(),
      name: String(f.name || '').trim(),
      unit: 'mm',
      // 声明包络：**目录的占地读的是它**（不是 product_model.bbox_*）——以前这里没写，
      // 于是向导建出来的产品会因“没有声明占地”进不了目录（服务端只 log.warn，界面无声）。
      ...d,
    }),
    status: 'draft',
  };

  return { product, model: modelOf(form, analysis, edits), notes: Array.isArray(f.notes) ? f.notes : [] };
}

/**
 * 提交成功后要保存的产品内容（卖点/参数）。
 *
 * 为什么单独拿出来：第 1 步的 ProductContentFields 是同一份数组的编辑器，
 * 但提交前必须做一次**去空白 / 丢空行**；否则界面看着空、库里却多一条空参数。
 * 简介不在这里 —— 它属于 product.description，随产品行一起入库。
 */
export function contentOf(form) {
  const f = form || {};
  const sellingPoints = (Array.isArray(f.sellingPoints) ? f.sellingPoints : [])
    .map((x) => String(x == null ? '' : x).trim())
    .filter(Boolean);
  const params = (Array.isArray(f.params) ? f.params : [])
    .map((p) => ({
      key: String((p && p.key) || '').trim(),
      value: String((p && p.value) == null ? '' : p.value).trim(),
      unit: String((p && p.unit) || '').trim(),
      group: String((p && p.group) || '').trim(),
    }))
    .filter((p) => p.key);
  return { sellingPoints, params };
}

/** 型号 → 目录 id（ASCII slug，进 URL 与缓存键，必须契合后端的 SLUG 规则）。 */
export function slugify(s) {
  return String(s == null ? '' : s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}
