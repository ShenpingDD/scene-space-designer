<script setup>
/**
 * SchemePanel —— 方案的"服务端那一面"：方案库 / 保存 / 另存 / 冲突处理
 *
 * 三条设计意图：
 *
 * 1. **界面里零业务判断**（老规矩）。这一层不算任何布局规则，只做搬运 + 把后端的话翻译成人话。
 *    上传用的是 `scheme.exportScheme` 的产物（与"导出方案"按钮**同一个**输出），
 *    吃回来用的是 `scheme.importScheme`（与"导入方案"按钮**同一条**路径）——
 *    没有第二条序列化路径，也就没有"存进去的和导出来的是两套东西"这种经典事故。
 *
 * 2. **冲突必须给两条出路**。409 只回一句"保存失败"是不合格的：
 *    用户此刻真正要决定的是"丢掉我的改动跟服务端最新版"还是"另存为新方案"。所以弹的是选择。
 *
 * 3. **后端没起要说清楚是后端没起**。不能把网络失败说成"保存失败"——那是两回事，
 *    一个该去看服务有没有开，一个该去看方案有没有问题（"怕安静"的延伸：也要怕含糊）。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { planSvg } from '../planSvg.js';
import { SHOT_VIEWS, shotHow } from '../views3d.js';
import {
  buildRequest, defaultSelection, human, missingOf, staleAfterEdit, statusLabel, roomMapOf,
} from '../delivery.js';
import { designer as d } from '../designer.js';
import { api, REASON } from '../api.js';
import { scheme } from '../kernel.js';
import { cfg } from '@core/params.js';
import { ROUTES, schemeIdOf } from '../router.js';
import { dropActiveDraft } from '../draft.js';
import { legacyGate } from '../legacyGate.js';
import { view3d } from '../scene3d.js';
import { denyText } from '../admin/roles.js';
import ShareDialog from './ShareDialog.vue';

/**
 * 能力门（B4f）——与维护端**同一张表**（服务端的 `AdminGate.caps()`，经 `/api/admin/me` 下发）。
 *
 * `caps === null` = 还没读到（后端不通）→ **不禁用**，但要把“读不到”这件事说出来。
 * `caps.writeSchemes === false`（viewer）→ 按钮**灰着并写明原因**，而不是隐藏：
 * 藏起来会让人以为功能坏丁（或者以为自己已经是管理员）。
 *
 * 这个门挡的是误操作，不是安全边界 —— 服务端 7 个写端点各自还有 `requireWriteSchemes`。
 */
const props = defineProps({
  caps: { type: Object, default: null },
  role: { type: String, default: '' },
});
const canWrite = computed(() => (props.caps ? !!props.caps.writeSchemes : null));
const noWriteText = computed(() => (canWrite.value === false ? denyText('writeSchemes', props.role) : ''));
const writeTitle = computed(() => (canWrite.value === false ? noWriteText.value : ''));

const open = ref(false);
const busy = ref(false);
const list = ref([]);
/** 「没读到列表」的原因。⭐ 与"服务端上还没有方案"**必须是两句话** —— 见 `fetchList` */
const listErr = ref('');
const name = ref('');
const note = ref('');

/** 服务端身份：`null` = 这份方案还没落过库 */
const currentId = ref(null);
const rev = ref(0);

/** 后端在线信息（null = 还没问过） */
const server = ref(null);
const errorText = ref('');

/** 冲突现场：服务端当前版本是多少（给出"刷新到最新 / 另存为"的依据） */
const conflict = ref(null);

/**
 * 旧方案转换预检现场（P4 / 设计决策记录）。
 *
 * 背景：`exportScheme` 一律写**新标识**（保存即升代），所以「保存」这一步就是
 * 旧语义 `legacy` → 新语义 `walls` 的转换点。旧方案可能靠矩形外框兜出一间房，
 * 转成开放场景会**少一间**——那是客户级回归，必须在导出前问一次内核并**挡住**。
 *
 * 三条规矩：
 *   ① `lossy` 就阻断，不许静默转换（要用户明确点「转为开放场景」）；
 *   ② 内核预检缺席/抛错时 **fail-closed**：宁可挡住，也不放行（放行就是静默少房间）；
 *   ③ 房名不删：`layout.roomLabels` 原样带走，靠内核「在等房间」口径等墙围回来。
 */
const legacyBlock = ref(null);
/** 用户明确同意过这一次转换（换一份方案要重置，别把上一份的同意带过来） */
const legacyConfirmed = ref(false);

/**
 * 封面（R6-3 3f / 2026-10-21 用户拍板改）：**保存后不再出现任何封面浮层**。
 *
 * 原先是保存按钮下方一块常驻预览 + 「封面已更新（xx KB）」+ 关掉按钮 ——
 * 用户确认封面本来就每次自动更新，这块浮层每次都要手动关，纯负担，所以成功路径**完全不出声**。
 * 但封面失败仍然是「必须说出来的事」（它决定维护端/方案库里那张图还在不在）：
 * 失败走顶栏那条自动消失的提示（`d.toast`，2.6 秒），不用手动关，也不占版面。
 * 「重截并更新」入口一并移除 —— 留着又是一块常驻 UI。
 */

/** 待确认删除的 id（两击确认，不用浏览器原生 confirm） */
const pendingDelete = ref(null);

/**
 * 「有没有未保存的改动」必须自己算，**不能复用 `d.isClean`** ——
 * 那个值的意思是"布局体检干净"（issues 为空），跟保存状态是两件事，混用就是语义错误。
 */
const savedJson = ref(null);
const dirty = computed(() => savedJson.value !== null && savedJson.value !== stateJson());

// ── 交付包（B7 / R6-5）──────────────────────────────────────────────────
//
// 分工：**图形由这里出**（平面图与三张固定视角只有浏览器画得出来），
// **数据由服务端出**（方案内容、目录、结论都在它手里）—— 见 `server` 侧 `Delivery` 的类注释。
//
// 三条必须写进界面的话（少一句就会让人以为"功能坏了"）：
//   ① 画布上有**未保存的改动**时不许打包 —— 否则包里"数据是旧版、截图是新版"，而它看不出来；
//   ② 少一件的包（比如这一份从来没截过封面）要**当场说出来**，不能只靠用户自己去数；
//   ③ 「已交付」是个**记录**不是开关：改回去要写原因（那句话进审计日志，改不了也删不掉）。
const dOpen = ref(false);          // 交付区展开着吗
const dItems = ref([]);            // 服务端下发的可勾选件清单（**界面不抄这张表**）
const dViews = ref([]);            // 三个固定视角（服务端的说法，用于展示与核对）
const dStatus = ref('');           // 交付流转状态（draft / delivered）
const dPick = ref([]);             // 勾选了哪几件
const dAssets = ref(false);        // 含 GLB 附件（决策⑧：体积大、默认不带）
const dNote = ref('');             // 交付备注
const dMsg = ref(null);            // 过程话术（截哪一张、打什么包）
const dErr = ref('');              // 交付区自己的错误
const dResult = ref(null);         // 这一包的结果（文件名 / 大小 / 少带了什么）
const dHistory = ref([]);          // 这张方案的交付记录
const dStateChanges = ref([]);     // 改交付状态的留痕
const dReset = ref('');            // 「改回未交付」的那句原因

async function loadDelivery() {
  if (!currentId.value) return;
  try {
    const r = await api.deliveries(currentId.value);
    dItems.value = r.items || [];
    dViews.value = r.views || [];
    dStatus.value = r.status || '';
    dHistory.value = r.deliveries || [];
    dStateChanges.value = r.stateChanges || [];
    // 第一次展开时默认**全勾**（勾选是"少要哪件"，不是"多要哪件" —— 交付包完整才是常态）
    if (!dPick.value.length) dPick.value = defaultSelection(dItems.value);
  } catch (e) {
    dErr.value = '读交付信息失败：' + (e && e.message ? e.message : '未知原因');
  }
}

function toggleDeliver() {
  dOpen.value = !dOpen.value;
  dErr.value = '';
  if (dOpen.value) {
    dMsg.value = null;
    dResult.value = null;
    loadDelivery();
  }
}

// 面板一打开就把交付信息读回来：状态徽标不能等到点「打交付包」才出现 ——
// 那时用户已经先看到一句「（没有状态）」，还以为这一份没有交付状态。
watch(open, (v) => {
  if (v) loadDelivery();
});

// 「同意转为开放场景」只对**点下去那一刻的这份布局**成立：布局一变就作废。
// （另半边在 `legacyPreflight`：同意被读取时立刻清掉，`legacyGate` 用 `consumeConsent` 表达。）
watch(() => d.layout.value, () => { legacyConfirmed.value = false; });

/** 把响应的 zip 落盘。必须走一次真正的 `<a download>`：走 `window.open` 会被拦、也可能只弹一个白页 */
function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'delivery.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让某些浏览器拿到一个空文件 —— 等一拍再收（10 秒足够下载开始）
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * 打一版交付包（A10）：勾选 → 截三张固定视角 → 画一张平面图 → 交给服务端打包并落记录。
 *
 * 截图与画图**都在这里做**，因为只有浏览器手里有渲染器。服务端只收现成的图，
 * 自己不重画一遍（两套渲染口径就会出现"交付包里的平面图与设计器看到的不一样"）。
 */
async function doPackage() {
  if (busy.value) return;
  dErr.value = '';
  dResult.value = null;
  if (!currentId.value) {
    dErr.value = '这一份还没保存过 —— 交付包要钉在某一版上，先保存一次';
    return;
  }
  if (dirty.value) {
    dErr.value = '画布上有**未保存的改动**：先保存一次再来打包。'
      + '包里的数据取自库里那一版、截图取自你屏幕上这一份 —— 两边对不上，事后谁也看不出来';
    return;
  }
  if (!dPick.value.length) {
    dErr.value = '一件都没勾：至少要留下 README 与方案.json（它们是包的根，本来就一直在）';
  }
  busy.value = true;
  try {
    const shots = [];
    const shotViews = [];
    if (dPick.value.includes('shots')) {
      for (let i = 0; i < SHOT_VIEWS.length; i++) {
        const v = SHOT_VIEWS[i];
        dMsg.value = { ok: true, text: '正在截第 ' + (i + 1) + '/' + SHOT_VIEWS.length + ' 张：' + v.label + '（' + shotHow(v) + '）' };
        // 让这句话先渲染出来再动相机（不然用户看到的是"卡住"，而其实正在一张张截）
        await new Promise((r) => setTimeout(r, 0));
        const url = view3d.shotView(v);
        if (!url) {
          throw new Error('第 ' + (i + 1) + ' 张（' + v.label + '）没截到：三维画布还没准备好 —— '
            + '把设计器里的三维视图打开、等它渲染出来再试一次');
        }
        shots.push(url);
        shotViews.push(v.id);
      }
    }
    let svg = '';
    if (dPick.value.includes('plan')) {
      dMsg.value = { ok: true, text: '正在画平面图（矢量 SVG）…' };
      svg = planSvg(d.layout.value, {
        name: name.value,
        at: new Date().toLocaleString('zh-CN'),
        rev: rev.value,
      });
    }
    dMsg.value = { ok: true, text: '正在打包…' };
    const body = buildRequest({
      rev: rev.value,
      items: dPick.value,
      withAssets: dAssets.value,
      note: dNote.value,
      planSvg: svg,
      shots,
      rooms: roomMapOf(d.layout.value),
    });
    body.shotViews = shotViews;
    const r = await api.packageDelivery(currentId.value, body);
    downloadBlob(r.blob, r.fileName);
    await loadDelivery();
    const newest = dHistory.value[0];
    dResult.value = {
      name: r.fileName,
      size: r.blob.size,
      count: (newest && newest.files ? newest.files.length : 0),
      missing: missingOf(dPick.value, dItems.value, newest ? newest.files : []),
    };
    dMsg.value = { ok: true, text: '交付包已生成并开始下载（' + human(r.blob.size) + '），方案已置为「已交付」' };
  } catch (e) {
    dErr.value = e && e.message ? e.message : '打交付包失败（未知原因）';
    dMsg.value = null;
  } finally {
    busy.value = false;
  }
}

/** 人工把交付状态改回去（A11 后半句）—— 必须写原因，那句话进审计日志 */
async function doResetState() {
  if (busy.value) return;
  dErr.value = '';
  if (!dReset.value.trim()) {
    dErr.value = '要写一句为什么（这句话进审计日志，改不了也删不掉）—— 例如「包打错了，重打一版」';
    return;
  }
  busy.value = true;
  try {
    await api.setDeliveryState(currentId.value, 'draft', dReset.value.trim());
    dReset.value = '';
    await loadDelivery();
    dMsg.value = { ok: true, text: '已改回「未交付」，这次改动留在审计里' };
  } catch (e) {
    dErr.value = e && e.message ? e.message : '改状态失败（未知原因）';
  } finally {
    busy.value = false;
  }
}

function stateJson() {
  // 与服务端上传的是同一份内容（exportScheme 的 state 段）
  return JSON.stringify(JSON.parse(scheme.exportScheme(d.layout.value)).state);
}

/**
 * 顶栏/面板上那句「方案名 · 版本」——V9 起用**轻量版本标签** `名称 · V3`。
 *
 * 为什么不写「第 3 版」：顶栏那颗 V 徽标（App.vue）已经把"第几版"独立说了一遍，
 * 名字里再重复一次既占地、又让点击改名的那一整块看起来像"版本号也能改"。
 * 新建、还没落库时**不显示 V** —— 没有版本可言，写个 V0 会让人以为存在第 0 版。
 * 「第 N 版」那种长说法留在方案库 / 版本历史里（那里才是版本要细看的地方）。
 */
const title = computed(() => {
  const n = name.value.trim();
  if (!n) return '未保存的方案';
  return currentId.value ? `${n} · V${rev.value}` : n;
});

/**
 * 顶栏那颗按钮：**有名字就直接存，没名字就先去命名**。
 *
 * 为什么不无脑 `save()`：没名字的方案存进库里就是一条叫"（空）"的记录，
 * 以后在列表里谁也认不出它是哪个现场 —— 所以先让他起名，别替他决定。
 *
 * V9 起顶栏方案名本身就能点着改名，所以"有名字的新方案"也要**直接存**：
 * 名字已经有了还弹方案库，等于让用户为一次保存多点两下。
 */
function saveFromTopbar() {
  if (busy.value) return;
  if (!name.value.trim()) {
    openLibrary();
    return;
  }
  save();
}
const badge = computed(() => {
  if (!currentId.value) return '未保存';
  return dirty.value ? '有未保存改动' : '已保存';
});

/** 标识的成色：灰 = 还没落过库 / 黄 = 有未保存改动 / 绿 = 已保存。
 *  颜色只是辅助 —— **文字才是主信息**（色盲、截图、打印都还得看字）。 */
const badgeClass = computed(() => {
  if (!currentId.value) return 'is-none';
  return dirty.value ? 'is-dirty' : 'is-saved';
});

/** 当前布局的 state 对象 —— 与服务端上传的是**同一份内容**（exportScheme 的 state 段） */
function stateObj() {
  return JSON.parse(scheme.exportScheme(d.layout.value)).state;
}

/**
 * 服务端复核：把布局递给裁判，与本地内核的结论**并排放**。
 *
 * 为什么不干脆全听服务端：拖动时每 90 ms 要在本地重算一次净空，
 * 服务端来回一趟（几十毫秒 + 网络）拖不动。所以分工是 ——
 * **交互反馈在前端，判定权在服务端**；这里把两边的数摊开，一致才说明两边是同一套规则，
 * 不一致就要查（不能只信一边）。
 *
 * 只在"打开方案库 / 保存完 / 手动刷新"这类明确的时刻跑，不跟每一次编辑。
 */
const verify = ref(null);
const verifyStale = computed(() => verify.value !== null && verify.value.json !== stateJson());

async function verifyWithServer() {
  const local = {
    items: d.count.value,
    trouble: d.clearance.value.filter((r) => r.level !== 'ok' && r.level !== 'n/a').length,
    issues: d.issues.value.length,
    wallIssues: d.wallIssues.value.length,
  };
  const json = stateJson();
  try {
    const r = await api.audit(JSON.parse(json));
    const s = { items: r.report.items, trouble: r.report.trouble, issues: r.report.issues,
      wallIssues: r.report.wallIssues ?? 0 };
    const same = s.items === local.items && s.trouble === local.trouble && s.issues === local.issues
      && s.wallIssues === local.wallIssues;
    verify.value = {
      ok: same,
      json,
      text: `服务端 ${s.items} 台 · ${s.trouble} 台门开不到底 · ${s.issues} 台放不下`
        + (s.wallIssues ? ` · ${s.wallIssues} 面墙在空间外` : '')
        + `｜本地 ${local.items} · ${local.trouble} · ${local.issues}`
        + (local.wallIssues ? ` · ${local.wallIssues}` : '')
        + (same ? `　一致（${r.cached ? '命中缓存' : '本次真算'} ${r.costMs} ms）` : '　不一致 —— 两边不是同一套规则，要查'),
    };
  } catch (e) {
    verify.value = {
      ok: false,
      json,
      text: e.reason === 'backend-down'
        ? '连不上后端 —— 服务端是唯一裁判，现在复核不了'
        : `复核失败：${e.message}`,
    };
  }
}

/**
 * 拉方案列表。
 *
 * ⭐ 两件事与"界面必须说真话"直接相关：
 *   ① **拉失败不说成"没有方案"**：`listErr` 一填，表格里就说"没读到列表"，
 *      而「服务端上还没有方案」只在**真的读到了、而且确实是空**的时候才出现 ——
 *      这两句话对用户意味着完全不同的下一步（去查后端 vs 去建一个方案）；
 *   ② **失败自动重试一次**：后端刚重启、连接被掉，都会有一次性的失败。
 *      第一版"进面板拉一次、失败就永远停在错话上"，实测把人骗过（看起来像"这个方案库是空的"）。
 *      重试仍然失败才认输，并把原因原话写出来。
 */
async function fetchList(attempt = 0) {
  try {
    // U1 起这个接口只回**自己的**方案（归属过滤在服务端）：这一栏就是"我的方案"
    list.value = await api.mySchemes();
    listErr.value = '';
  } catch (err) {
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 400));
      return fetchList(1);
    }
    listErr.value = err?.data?.message || err?.message || '读不到方案列表';
    list.value = [];
  }
}

async function refresh() {
  busy.value = true;
  errorText.value = '';
  try {
    // 列表**自己吞掉失败**（写进 listErr），不把整批 Promise.all 一起拖垮 ——
    // 否则只是列表接口不顺，连"后端在线 · 内核用例 n/n"那行也会跟着消失，
    // 看起来像"整个后端都没起"。
    [server.value] = await Promise.all([
      api.health().then(() => api.kernelHealth()).catch(() => null),
      // 顺手做一次服务端复核：打开方案库 / 保存完 / 手动刷新都会走到这里
      verifyWithServer(),
      fetchList(),
    ]);
  } catch (err) {
    handle(err);
  } finally {
    busy.value = false;
  }
}

/**
 * 打开方案库。
 *
 * **刻意写成幂等，而不是 `open = !open`**：这是被实测教出来的 ——
 * 自动化/合成点击可能**成对送达**（press 与 release 各触发一次），
 * 开关式的写法就会"开完立刻被自己关掉"，表现为"点了没反应"（而代码看起来完全正确）。
 * 用户真实的操作里，双击这个按钮也是常见动作 —— 那时同样不该把自己关掉。
 */
async function openLibrary() {
  open.value = true;
  await refresh();
}

/**
 * 顶栏「更多 → 分享方案」进来：**开分享自己的那个弹窗**。
 *
 * 2026-10-08 用户拍板：分享是独立一个窗，**不要和方案库混在一起**。
 * 原来这里是「打开方案库面板 + 把里面那一块滚到眼前」（当时的理由是"同一件事只有一处实现"）——
 * 用户看到的是分享内容和方案库内容同屏，所以推翻了那个做法。实现仍然只有一处：
 * 那一段从 `ShareBox.vue` **搬进了 `ShareDialog.vue`**（旧文件删掉，不是再写一个）。
 *
 * ⚠️ 弹窗挂在**面板抽屉之外**（看模板末尾）：挂在抽屉里的话，抽屉一关弹窗就跟着没了。
 * ⚠️ 不再 `open.value = true`：背后不该顺带把方案库拉开。
 * ⚠️ **不先 `await refresh()`**（实机踩过）："打开"这件事不该挂在一次网络请求的成功上 ——
 *    请求一旦不顺，弹窗就永远不出现，用户看到的是「点了没反应」。现在先开窗，
 *    该读的东西由弹窗自己读、自己报错（它里面本来就有那一套）。
 */
const shareOpen = ref(false);

function openShare() {
  shareOpen.value = true;
}

/** 关闭只走「关闭」按钮与 Esc（不点遮罩即关，见文件头的说明） */
function onKeydown(e) {
  if (e.key === 'Escape') open.value = false;
}

/**
 * 跟着地址走：`/design/<id>` 打开那一份，`/design/new` 就是新方案那一档。
 *
 * ⚠️ **实测踩过的坑**（hash 路由时代的同一条教训）：只在 `onMounted` 里读一次，
 *    从维护端跳过来能用，但在设计器里粘贴一个地址、或按一下后退键就**完全没反应** ——
 *    地址变了、组件不重新挂载（`/design/new` 与 `/design/:id` 是同一个组件）。
 *    所以订阅路由参数变化，而不是挂载时读一次。
 *
 * 为什么不会出现"跳转→加载→又跳转"的回声：打开方案时**不写地址栏**（地址由用户/路由决定），
 * 而且已经在看的那一份不再重复加载（下面的 `currentId` 判断）。
 */
const route = useRoute();
const router = useRouter();

async function consumeDeepLink() {
  if (route.name === ROUTES.DESIGN_NEW) {
    // 走到"新方案"这一档就要**忘掉手里这份 id**：否则下一次保存会覆盖上一份方案
    if (currentId.value !== null) {
      currentId.value = null;
      rev.value = 0;
      conflict.value = null;
      errorText.value = '';
      savedJson.value = null;
      legacyBlock.value = null;
      legacyConfirmed.value = false;
      d.reset();
    }
    return;
  }
  const deep = schemeIdOf(route.params.id);
  if (deep === null || deep === currentId.value) return;
  await load(deep);
  // ⚠️ **打不开的时候必须让用户看见**：`load()` 失败只写了 errorText，
  //    而那段文字在**关着的面板里**（v-if）—— 于是表现为「点了没反应」。
  if (errorText.value) open.value = true;
}

watch(() => [route.name, route.params.id], consumeDeepLink, { immediate: true });

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
});

function handle(err) {
  if (err.reason === 'backend-down') {
    server.value = null;
    errorText.value = '连不上后端（127.0.0.1:8080）。先启动后端：server/serve.sh，或 VS Code 任务「后端 · 常驻运行」。';
  } else if (err.reason === REASON.REV_CONFLICT) {
    conflict.value = { currentRev: err.data?.currentRev ?? null };
    errorText.value = '';
  } else if (err.reason === REASON.FORBIDDEN) {
    // 角色门挡下的（403）：服务端已经说清“要哪一档才能做” —— **原话贴出来**，
    // 一个字都不翻译（翻译成“失败”就把唯一有用的信息丢了）。
    errorText.value = '服务端挡下了：' + (err.data?.message || err.message);
  } else {
    errorText.value = err.data?.message || err.message;
  }
}

/**
 * 打开服务端上的一份方案。
 * `quiet`：保存后按新语义重载时用 —— 少一句「已打开」，别把刚说的「已保存」盖掉。
 */
async function load(id, { quiet = false } = {}) {
  busy.value = true;
  errorText.value = '';
  conflict.value = null;
  // 换了一份方案：上一份的「同意转为开放场景」不能带过来（它只对那一份成立）
  legacyBlock.value = null;
  legacyConfirmed.value = false;
  try {
    const row = await api.getScheme(id);
    if (!d.applyServerState(row.state, row.format)) {
      errorText.value = '这份方案的 state 没能通过内核校验（服务端不该存进这种数据，请报一下）';
      return;
    }
    currentId.value = row.id;
    rev.value = row.rev;
    name.value = row.name;
    savedJson.value = stateJson();
    if (!quiet) d.toast(`已打开「${row.name}」（V${row.rev}）`);
    open.value = false;
  } catch (err) {
    handle(err);
  } finally {
    busy.value = false;
  }
}

/**
 * 封面图：**固定正面斜 45°**（与交付包里第一张同机位）。
 *
 * 为什么不再是"保存那一刻的三维视角"：
 *   ① 三维没挂载时（人在平面图里设计）原来的路只会拿到 `null` → 维护端列表全是「无封面」；
 *   ② 固定机位让同一份方案**每次都是同一张图** —— 封面不再是"谁点的保存"的函数。
 * `snapshotOffscreen` 在三维已挂载时直接用现成画布，没挂载才离屏渲一张。
 */
async function coverShot() {
  const view = SHOT_VIEWS.find((v) => v.id === 'front45') || SHOT_VIEWS[0];
  return view3d.snapshotOffscreen(d.layout.value, view);
}

/**
 * 把刚截的那张存成封面（R6-3 3f）。
 *
 * ⚠️ **封面没存上不算保存失败**：内容已经在库里了，封面是**附加物**。
 * 但也不能静默 —— 失败一律用顶栏那条自动消失的提示说出来（「内容已保存，封面没存上：原因」），
 * 成功则完全不出声：封面是每次保存的附带动作，用户不该为它点任何按钮。
 */
async function pushCover(shot) {
  if (!currentId.value) return;
  if (!shot) {
    d.toast('内容已保存，封面没截到（三维画布没准备好）');
    return;
  }
  try {
    await api.saveSchemeCover(currentId.value, shot);
  } catch (err) {
    d.toast('内容已保存，封面没存上：' + (err?.message || '未知原因'));
  }
}

/**
 * 旧方案转换预检：返回 `null` = 可以继续保存；返回 `{ok:false,...}` = 已阻断（block 已写、面板已开）。
 *
 * 判据全部来自内核 `scheme.legacyConvertReport`（`{ok,error,lossy,roomsBefore,roomsAfter,
 * labelsKept,droppedLabels,droppedLabelNames,openAreaM2}`）—— 界面不拿两次 `roomsOf` 自己拼语义。
 *
 * ⚠️ 这里有两条"想当然就写错"的路，都踩过 / 差点踩：
 *   ① **用户点过「转为开放场景」之后必须放行** —— 早先这里只判 `semantics !== 'legacy'`，
 *      于是 `convertLegacy()` 置了同意、`save()` 再进来仍读到 lossy，永远存不进去（死循环）；
 *   ② 同意是**一次性**的：读完即清。保存失败、或布局又改了，都不能留下"以后都放行"。
 */
function legacyPreflight() {
  const gate = legacyGate({
    semantics: d.schemeMeta?.value?.roomSemantics,
    consent: legacyConfirmed.value,
    // 内核没接线时 `read()` 返回 null → gate 走 fail-closed（宁可挡住，也不静默少房间）
    read: () => (typeof scheme.legacyConvertReport === 'function' ? scheme.legacyConvertReport(d.layout.value) : null),
  });
  if (gate.consumeConsent) legacyConfirmed.value = false;
  if (gate.action === 'proceed') return null;
  legacyBlock.value = gate.report
    ?? { ok: false, error: gate.message, lossy: true, roomsBefore: 0, roomsAfter: 0, droppedLabelNames: [] };
  d.toast(gate.message);
  open.value = true;
  return { ok: false, reason: gate.reason, message: gate.message };
}

/** 用户明确同意「转为开放场景」：记下这次同意，再走同一条保存 */
function convertLegacy() {
  legacyConfirmed.value = true;
  legacyBlock.value = null;
  return save();
}

/**
 * 保存这一份 —— 顶栏「保存」、方案库里的按钮、以及首页模态的「保存并返回」**共用同一条路**。
 *
 * 返回值 `{ ok, reason, message }` 是给「保存并返回」判生死的：调用方**只看它**，
 * 不去猜 errorText / conflict 是不是空 —— "猜"正是"保存失败却假装成功跳走"的来源。
 * 普通按钮点了不看返回值，行为与以前完全一样。
 *
 * ⚠️ 失败**必须让用户在面板关着时也看见**（第三轮 验收：“房间存不下、页面也没提示”）：
 *   · 顶栏保存不打开面板，`errorText` / 冲突块都写在关着的面板里 → 用户什么都没看到；
 *   · 所以失败一律先 `d.toast(message)`（2.6 秒自动消失，够看见），
 *     再把面板打开 —— 细节原话（服务端校验原因 / 「连不上后端」该怎么办）与冲突的两条出路
 *     都在面板里，只 toast 一句会让人"知道失败了但不知道下一步"。
 * 成功路径**不**加回常驻浮层（设计决策记录已移除封面浮层，别回退）。
 */
async function save({ asNew = false } = {}) {
  const clean = name.value.trim();
  if (!clean) {
    errorText.value = '请先填方案名（服务端要求非空、不超过 128 字）';
    return { ok: false, reason: 'no-name', message: '还没有方案名' };
  }
  if (busy.value) return { ok: false, reason: 'busy', message: '正在保存，请稍候' };
  // 旧方案转换预检放在**截图与导出之前**：被拦下时不该先花一次离屏截图，更不该碰到导出（导出即升代）
  // 保存前先查“墙上界”——拖墙端点历史版本允许拖到 0.1 m 以下，服务端会整份拒绝。
  // 这里把具体是哪一面、多长、怎么修说清楚，并选中它；不是又抛一句“保存失败”。
  const shortWalls = d.layout.value.walls
    .map((w, i) => ({ i, len: Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) }))
    .filter((w) => w.len < cfg.scheme.minWallLengthM);
  if (shortWalls.length) {
    const first = shortWalls[0];
    errorText.value = `第 ${first.i + 1} 面墙只有 ${first.len.toFixed(2)} m，短于最小长度 ${cfg.scheme.minWallLengthM} m。已选中它：拖长端点，或按 Delete 删除后再保存。`;
    d.selectWall(first.i);
    open.value = true;
    d.toast(errorText.value);
    return { ok: false, reason: 'short-wall', message: errorText.value };
  }
  const semanticsBefore = d.schemeMeta?.value?.roomSemantics;
  const blockedByLegacy = legacyPreflight();
  if (blockedByLegacy) return blockedByLegacy;
  busy.value = true;
  errorText.value = '';
  conflict.value = null;
  // **先截再存**：截的是**当前这份布局**。等保存成功再截就晚了 ——
  // 那时 refresh() 可能已经切到别的方案，布局已经不是这一份了。
  // （机位固定正面斜 45°，所以不再依赖"用户当时在哪个视图"。）
  const shot = await coverShot();
  const state = JSON.parse(scheme.exportScheme(d.layout.value)).state;
  // 另存为新方案时给名字加后缀：否则列表里会出现两行同名，用户分不清"保住的改动"是哪一份
  const finalName = asNew && currentId.value !== null ? `${clean}（副本）` : clean;
  try {
    if (currentId.value === null || asNew) {
      const r = await api.createScheme(finalName, state);
      currentId.value = r.id;
      rev.value = r.rev;
      // 存进去了，本机那份草稿就不需要了（它只属于"还没保存的新方案"）
      dropActiveDraft();
      // 地址换成这一份：**replace** 不留下 `/design/new` 的历史条目 ——
      // 否则按一次后退会回到"新建"那一档，而它现在是空白的（看起来像改动没了）。
      router.replace('/design/' + r.id);
    } else {
      // 带上手里的 rev —— 服务端对不上就回 409，而不是默默覆盖别人的改动
      const r = await api.saveScheme(currentId.value, rev.value, clean, state, note.value);
      rev.value = r.rev;
    }
    name.value = finalName;
    note.value = '';
    savedJson.value = stateJson();
    d.toast(`已保存「${finalName}」（V${rev.value}）`);
    await refresh();
    await pushCover(shot);
    // 旧方案刚被写成新标识（保存即升代）：内存里还是 legacy 语义，**必须按新语义重载一次**，
    // 否则「少掉的那间房」在界面上还站着、房名也没进「在等房间」—— 那就是"存的和看的不一样"。
    if (semanticsBefore === 'legacy') {
      try {
        await load(currentId.value, { quiet: true });
      } catch (err) {
        // 保存已经成功，只是没重载成功 —— 如实说一句，不假装一切正常
        errorText.value = '已保存，但没能在新语义下重新载入这份方案（刷新页面即可）';
      }
    }
    return { ok: true, id: currentId.value, rev: rev.value, name: finalName };
  } catch (err) {
    handle(err);
    // 409 与"连不上后端"下一步动作完全不同，别都用一句"保存失败"糊过去
    const message = err?.reason === REASON.REV_CONFLICT
      ? '这个方案在别处被改过了：先在方案库里处理冲突，再离开'
      : (err?.reason === 'backend-down'
        ? '连不上后端：先启动服务，再保存'
        : (err?.data?.message || err?.message || '保存没成功'));
    // 面板关着时只有这条路能让用户知道"没存上"（顶栏红字在面板里，看不见）
    d.toast(message);
    // 冲突：两条出路（刷新到最新 / 另存为新方案）只在面板里，必须打开；
    // 服务端校验失败（如 wall-out-of-room）：原话只在 `errorText` 里，同样要看得见。
    open.value = true;
    // ⚠️ 这里**不能**调 `refresh()`：它一上来就把 `errorText` 清空（就是刚写进去的那句原因）。
    // 但列表也可能从来没读过 —— 那样面板会显示「服务端上还没有方案」，
    // 一句我们没读过就不能说的话。所以只补拉列表（`fetchList` 自己吞错、只写 listErr），
    // 不 await：面板先开，列表到了再填（冲突时顺带把最新版本号带进来）。
    void fetchList();
    return { ok: false, reason: err?.reason || 'error', message };
  } finally {
    busy.value = false;
  }
}

/* ---------------- 方案名（第二轮 验收 · V9）----------------
 *
 * 名字与"存进哪一份"是两件事，所以**不借 save()**：
 *   · 已保存的方案 → `PATCH /schemes/{id}/name`：只改名称，**不增 rev、不写版本记录**；
 *   · 还没落库的新方案 → 只改本地 `name`，第一次保存时自然带上去。
 * 失败**不预先改本地**（先请求、成功才写）—— 这样"失败恢复原名"不是靠回滚，
 * 而是本来就没改过，不存在"回滚失败留在错名字上"的中间态。
 */

/**
 * 改方案名（已保存走接口、新方案只改本地）。
 * 返回 `{ ok, name?, message? }`：调用方（App 顶栏）据此决定显示哪个名字、要不要 toast。
 */
async function rename(next) {
  const clean = String(next == null ? '' : next).trim();
  if (!clean) return { ok: false, message: '方案名不能为空' };
  if (clean.length > 128) return { ok: false, message: '方案名不能超过 128 字' };
  if (clean === name.value) return { ok: true, name: clean };
  if (currentId.value === null) {
    name.value = clean;
    return { ok: true, name: clean };
  }
  try {
    const r = await api.renameScheme(currentId.value, clean);
    name.value = (r && r.name) || clean;
    // rev 以服务端回执为准；按约定这一趟不增 rev（回执里应与手里的一致）
    if (r && Number.isFinite(r.rev)) rev.value = r.rev;
    return { ok: true, name: name.value };
  } catch (err) {
    return {
      ok: false,
      reason: err?.reason,
      message: err?.data?.message || err?.message || '重命名没成功（未知原因）',
    };
  }
}

/**
 * 「保存并返回」用的保存入口：**只有真的存下来了才回 ok**。
 * 新方案没名字时不静默失败 —— 回一句能指导下一步的话，App 留在当前页显示。
 */
async function saveForLeave() {
  const clean = name.value.trim();
  if (!clean) {
    errorText.value = '请先填方案名（服务端要求非空、不超过 128 字）';
    return { ok: false, reason: 'no-name', message: '新方案还没有名字：先点顶栏的方案名起个名字，或打开方案库保存' };
  }
  return save();
}

/** 冲突的两条出路之一：拉最新覆盖本地 */
async function takeServer() {
  const id = currentId.value;
  conflict.value = null;
  if (id) await load(id);
}

/** 冲突的两条出路之二：另存为新方案（用户的改动不丢） */
async function saveAsNew() {
  conflict.value = null;
  await save({ asNew: true });
}

async function remove(id) {
  if (pendingDelete.value !== id) {
    pendingDelete.value = id;
    return;
  }
  pendingDelete.value = null;
  busy.value = true;
  try {
    await api.deleteScheme(id);
    if (currentId.value === id) {
      currentId.value = null;
      rev.value = 0;
      savedJson.value = null;
      d.toast('服务端那份已删除，本地这份还在（未保存状态）');
    }
    await refresh();
  } catch (err) {
    handle(err);
  } finally {
    busy.value = false;
  }
}

function newLocal() {
  currentId.value = null;
  rev.value = 0;
  name.value = '';
  savedJson.value = null;
  conflict.value = null;
  d.reset();
  open.value = false;
}

function fmtTime(iso) {
  if (!iso) return '';
  return iso.replace('T', ' ').slice(5, 16);
}

/** 顶栏要用（验收2 · 壳层）：方案库/分享入口、方案名与版本、保存状态，
 *  以及顶栏内联改名与「保存并返回」这两个动作。
 *  ⚠️ 只暴露**顶栏真的需要**的东西：顶栏不许自己算"有没有未保存改动"（那是这一层的口径）。 */
defineExpose({
  openLibrary, openShare,
  title, badge, badgeClass,
  currentId, name, rev, dirty,
  rename, saveForLeave,
});
</script>

<template>
  <div class="sp">
    <button class="btn btn--primary sp__save" data-act="save" :title="writeTitle || title" :disabled="canWrite === false" @click="saveFromTopbar()">
      保存
    </button>

    <!-- 封面不再在这里显示（2026-10-21 用户拍板）：保存后它自动生成并上传，
         成功不出声；失败由顶栏那条自动消失的提示说出来（见 `pushCover`）。 -->

    <div v-if="open" class="sp__mask" @click.self="open = false">
      <section class="sp__modal" role="dialog" aria-label="方案库">
        <header class="sp__head">
          <b>方案库</b>
          <span class="sp__now">{{ title }}</span>
          <span class="spacer" style="flex:1" />
          <span v-if="server" class="sp__online">
            后端在线 · 内核用例 {{ server.passed }}/{{ server.total }}
            <!-- ⭐ 必须说清「裁判用的是哪一份目录」：以前这里只写 22/22，而那时服务端
                 拿的是**用例表内嵌的 3 款**跑分 —— 目录里第 4 款界面能摆、服务端报
                 bad-item，这一行照样是绿的（假绿就是这么来的）。 -->
            <b v-if="server.catalogOrigin">（跑的是你的产品目录 · {{ server.catalogProducts }} 款 · 来源：{{ server.catalogOrigin }}）</b>
          </span>
          <span v-else class="sp__offline">后端未连接</span>
          <button class="btn" @click="open = false">关闭</button>
        </header>

        <div class="sp__form">
          <label>
            方案名
            <input v-model="name" class="sp__input" placeholder="例如：常温库房 A 区" maxlength="128">
          </label>
          <label>
            版本说明（可选）
            <input v-model="note" class="sp__input" placeholder="例如：把 #3 转 90°" maxlength="255">
          </label>
          <div class="sp__actions">
            <button class="btn btn--primary" :disabled="busy || canWrite === false" :title="writeTitle" @click="save()">
              {{ currentId ? '保存' : '保存为新方案' }}
            </button>
            <button class="btn" :disabled="busy || !currentId || canWrite === false" :title="writeTitle" @click="save({ asNew: true })">另存为新方案</button>
            <button class="btn" :disabled="busy" @click="newLocal()">新建（本地）</button>
            <button class="btn" :disabled="busy" @click="refresh()">刷新列表</button>
          </div>
          <!-- 灰着的按钮旁必须有一句“为什么”（B4f）：只有灰色而没有理由，
               用户会当成 bug（或者以为是自己网不好）。 -->
          <p v-if="canWrite === false" class="sp__gate">{{ noWriteText }}</p>
          <p v-else-if="canWrite === null" class="sp__gate sp__gate--unknown">
            没读到你的角色（后端不通或 /admin/me 出错）—— 按钮不禁用，点下去由服务端判定
          </p>

          <!-- 分享已搬进自己的弹窗（`ShareDialog`，挂在面板外面）—— 这里不再摆那一块：
               用户 2026-10-08 拍板"分享不要和方案库混在一起"。 -->
          <!-- ── 交付包（R6-5 · A10/A11/A13）────────────────────────────────
               这一块只在"载着一份真的存下来的方案"时有意义：交付包要钉在某一版上，
               没有版本号就没有可钉的东西。 -->
          <div v-if="currentId" class="sp__deliver">
            <div class="sp__dlhead">
              <b>交付包</b>
              <span class="sp__dlstatus" :class="{ 'is-done': dStatus === 'delivered' }">{{ statusLabel(dStatus) }}</span>
              <span v-if="dStatus === 'delivered'" class="sp__dlhint">{{ staleAfterEdit(dStatus) }}</span>
              <button class="btn" :disabled="busy || canWrite === false" :title="writeTitle" @click="toggleDeliver()">
                {{ dOpen ? '收起交付包' : '打交付包…' }}
              </button>
              <button v-if="dStatus === 'delivered'" class="btn" :disabled="busy || canWrite === false" :title="writeTitle" @click="dReset = dReset || ' '">
                改回未交付…
              </button>
            </div>

            <div v-if="dOpen" class="sp__dlbody">
              <p class="sp__dlnote">
                交付包按 <b>设计决策记录</b> 的七件打包；三维截图是 <b>3 张固定视角</b>（A13）：<span
                  v-if="dViews.length"
                  class="sp__dlviews">{{ dViews.map((v) => v.label).join(' · ') }}</span>。
                截图时相机会临时挪到那三个机位，<b>截完自动还原</b>（不会动你现在的视角）。
                图形（平面图 / 截图）由这个浏览器现画，数据（方案 / 清单 / 体检报告 / README）由服务端现取 ——
                所以<b>画布上不能有未保存的改动</b>。
              </p>

              <div class="sp__dlpick">
                <label v-for="i in dItems" :key="'d' + i.id" class="sp__dlitem" :title="i.why">
                  <input type="checkbox" :value="i.id" v-model="dPick">
                  <span>{{ i.label }}</span>
                  <em v-if="i.required" class="sp__dlreq">必带</em>
                  <em v-else-if="i.fromBrowser" class="sp__dlreq sp__dlreq--browser">要现画</em>
                </label>
              </div>

              <div class="sp__dlrow">
                <label class="sp__dlitem" title="体积大，默认不带（决策⑧）">
                  <input type="checkbox" v-model="dAssets">
                  <span>带上 GLB 附件（用到的产品模型）</span>
                </label>
                <label class="sp__dlitem">
                  交付备注
                  <input v-model="dNote" class="sp__input" maxlength="255" placeholder="例如：第一批三台，交车间核对">
                </label>
              </div>

              <div class="sp__actions">
                <button class="btn btn--primary" :disabled="busy || canWrite === false" :title="writeTitle" @click="doPackage()">
                  生成并下载交付包
                </button>
              </div>

              <p v-if="dMsg" class="sp__dlmsg" :class="dMsg.ok ? 'is-ok' : 'is-bad'">{{ dMsg.text }}</p>
              <p v-if="dErr" class="sp__err">{{ dErr }}</p>

              <div v-if="dResult" class="sp__dlresult">
                <b>这一包：</b>{{ dResult.name }}（{{ human(dResult.size) }} 共 {{ dResult.count }} 个文件）
                <ul v-if="dResult.missing.length" class="sp__dlmiss">
                  <li v-for="(m, i) in dResult.missing" :key="'m' + i">⚠️ 没带上：{{ m }}</li>
                </ul>
              </div>

              <div v-if="dReset" class="sp__dlreset">
                <b>改回「未交付」</b> —— 要写一句为什么（进审计日志）：
                <input v-model="dReset" class="sp__input" maxlength="255" placeholder="例如：包打错了，重打一版">
                <button class="btn" :disabled="busy || canWrite === false" :title="writeTitle" @click="doResetState()">确认改回</button>
                <button class="btn" @click="dReset = ''">取消</button>
              </div>

              <!-- 交付记录：谁、什么时候、打的哪一版、几件（**"已交付"是记录，不是一个开关**） -->
              <div v-if="dHistory.length" class="sp__dlhist">
                <b>交付记录（{{ dHistory.length }} 次）</b>
                <ul>
                  <li v-for="h in dHistory" :key="'h' + h.id">
                    第 {{ h.rev }} 版 · 参数第 {{ h.paramsRev }} 版 ·
                    {{ h.files ? h.files.length : 0 }} 个文件 ·
                    {{ h.packagedBy }} · {{ h.packagedAt }}
                    <span v-if="h.withAssets">· 含 GLB</span>
                    <span v-if="h.note">· {{ h.note }}</span>
                  </li>
                </ul>
              </div>
              <p v-else class="sp__dlnote">还没有交付记录 —— 打一版就有了（记录只加不改）。</p>

              <div v-if="dStateChanges.length" class="sp__dlhist">
                <b>交付状态改动留痕</b>
                <ul>
                  <li v-for="c in dStateChanges" :key="'c' + c.id">
                    {{ c.actor }} · {{ c.created_at }} · {{ c.detail_json }}
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <p v-if="errorText" class="sp__err">{{ errorText }}</p>

        <!-- 旧方案转换预检：有损就挡在这里，两条出路写清楚（不静默少一间房） -->
        <div v-if="legacyBlock" class="sp__conflict" data-legacy-block>
          <b>这份旧方案的房间数依赖矩形外框。</b>
          <template v-if="legacyBlock.ok !== false">
            转成开放场景后房间 {{ legacyBlock.roomsBefore }} → {{ legacyBlock.roomsAfter }} 间<template
              v-if="legacyBlock.fewer"
            >（少 {{ legacyBlock.fewer }} 间）</template>；
            开放场景面积约 {{ Math.round((legacyBlock.openAreaM2 ?? 0) * 100) / 100 }} m²。
            <template v-if="legacyBlock.lost && legacyBlock.lost.length">
              房间名「{{ legacyBlock.lost.join('」「') }}」不会丢：先挂起，墙围回去就回来。
            </template>
          </template>
          <template v-else>{{ legacyBlock.error || '转换预检没有通过，原因未知' }}</template>
          <div class="sp__actions">
            <button class="btn" @click="legacyBlock = null">先回去补墙（不改语义）</button>
            <button
              v-if="legacyBlock.ok !== false"
              class="btn btn--primary" data-convert-legacy @click="convertLegacy()"
            >转为开放场景并保存</button>
          </div>
        </div>

        <div v-if="conflict" class="sp__conflict">
          <b>这个方案在别处被改过了。</b>
          你手里是第 {{ rev }} 版，服务端已经是第 {{ conflict.currentRev ?? '?' }} 版 —— 直接覆盖会丢掉那边的改动。
          <div class="sp__actions">
            <button class="btn" @click="takeServer()">刷新到最新（丢弃我的改动）</button>
            <button class="btn btn--primary" @click="saveAsNew()">另存为新方案（保住我的改动）</button>
          </div>
        </div>

        <div v-if="verify" class="sp__verify">
          <span class="sp__vdot" :class="verify.ok ? 'is-ok' : 'is-bad'" />
          <span class="sp__vtext">{{ verify.text }}</span>
          <span v-if="verifyStale" class="sp__vstale">（布局已改动，这一条已过期）</span>
        </div>

        <table class="sp__table">
          <thead>
            <tr><th>编号</th><th>方案名</th><th>房间</th><th>设备</th><th>体检</th><th>版本</th><th>更新时间</th><th /></tr>
          </thead>
          <tbody>
            <tr v-for="row in list" :key="row.id" :class="{ 'is-current': row.id === currentId }">
              <td class="mono">{{ row.id }}</td>
              <td>{{ row.name }}</td>
              <td class="mono">{{ row.room.w }} × {{ row.room.d }} × {{ row.room.h }} m</td>
              <td class="mono">{{ row.itemCount }}</td>
              <td class="sp__audit">
                <template v-if="row.auditNow">
                  <span v-if="row.auditNow.issues" class="sp__tag is-bad" :title="`${row.auditNow.issues} 台放不下（越界 / 占地重叠 / 压内墙）`">放不下 {{ row.auditNow.issues }}</span>
                  <span v-if="row.auditNow.trouble" class="sp__tag is-warn" :title="`${row.auditNow.trouble} 台的门开不到 90° —— 摆得下，但用起来别扭`">门 {{ row.auditNow.trouble }}</span>
                  <span v-if="!row.auditNow.issues && !row.auditNow.trouble" class="sp__tag is-ok" title="摆得合规，且门都开得到底">ok</span>
                </template>
                <span v-else class="sp__tag is-muted">—</span>
              </td>
              <td class="mono">v{{ row.rev }}</td>
              <td class="mono">{{ fmtTime(row.updatedAt) }}</td>
              <td class="sp__row-actions">
                <button class="btn" :disabled="busy || canWrite === false" :title="writeTitle" @click="load(row.id)">打开</button>
                <button class="btn btn--danger" :disabled="busy || canWrite === false" :title="writeTitle" @click="remove(row.id)">
                  {{ pendingDelete === row.id ? '再点一次确认' : '删除' }}
                </button>
              </td>
            </tr>
            <tr v-if="listErr">
              <td colspan="8" class="sp__empty sp__empty--bad">
                <b>没读到方案列表</b>（不是「服务端上还没有方案」）：{{ listErr }}
                <button class="btn btn--tiny" :disabled="busy" @click="refresh()">重取列表</button>
              </td>
            </tr>
            <tr v-else-if="!list.length">
              <td colspan="8" class="sp__empty">服务端上还没有方案 —— 填个名字点「保存为新方案」</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 分享弹窗挂在**抽屉之外**：抽屉一关它不能跟着消失（用户要的是"独立一个窗"）。
         它自己 `Teleport` 到 body，所以这里放哪儿都不影响它盖在谁上面。 -->
    <ShareDialog
      :open="shareOpen" :scheme-id="currentId" :caps="caps" :role="role"
      @close="shareOpen = false" @open-library="openLibrary()"
    />
  </div>
</template>

<style scoped>
.sp { display: inline-flex; position: relative; }

/* 能力门的说明行（B4f）：跟按钮并排，不弹窗不冒泡 —— 「为什么它灰着」应当一眼看得见 */
.sp__gate { margin: 6px 0 0; font-size: 12px; line-height: 1.5; color: #b45309; }
/* 「没读到列表」与「确实是空」必须一眼看得出区别 —— 前者是红的，后者是灰的 */
.sp__empty--bad { color: #b91c1c; }
.btn--tiny { font-size: 12px; padding: 2px 8px; margin-left: 6px; }
.sp__gate--unknown { color: #64748b; }

/* 封面成功提示已移除（2026-10-21）：保存后不再有浮层。
   失败走顶栏 `.toast`（全局、2.6 秒自动消失），所以这里不需要封面浮层那一套样式。 */
.sp__badge {
  margin-left: 6px; padding: 1px 6px; border-radius: 8px;
  background: rgba(255, 255, 255, 0.18); font-size: 11px;
}
.sp__badge.is-dirty { background: #b45309; color: #fff; }  /* #d97706 上的白字只有 3.19 */

/* ── 交付包（R6-5）──────────────────────────────────────────────────── */
.sp__deliver { margin-top: 12px; border-top: 1px solid #e5e5e5; padding-top: 10px; }
.sp__dlhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sp__dlstatus { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: #eee; color: #555; }
.sp__dlstatus.is-done { background: #d1fae5; color: #065f46; }
.sp__dlhint { font-size: 12px; color: #92400e; }
.sp__dlbody { margin-top: 8px; }
.sp__dlnote { font-size: 12px; color: #555; line-height: 1.6; }
.sp__dlviews { color: #1e3a8a; }
.sp__dlpick { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 6px 0; }
.sp__dlitem { display: flex; align-items: center; gap: 4px; font-size: 13px; }
.sp__dlreq { font-size: 11px; color: #065f46; background: #d1fae5; border-radius: 8px; padding: 1px 6px; }
.sp__dlreq--browser { color: #1e3a8a; background: #dbeafe; }
.sp__dlrow { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; margin: 6px 0; }
.sp__dlmsg { font-size: 13px; }
.sp__dlmsg.is-ok { color: #065f46; }
.sp__dlmsg.is-bad { color: #b91c1c; }
.sp__dlresult { font-size: 13px; background: #f8f8f8; border-radius: 6px; padding: 6px 8px; margin-top: 6px; }
.sp__dlmiss { margin: 4px 0 0 18px; color: #92400e; }
.sp__dlreset { margin-top: 8px; font-size: 13px; background: #fffbeb; border-radius: 6px; padding: 6px 8px; }
.sp__dlhist { margin-top: 8px; font-size: 12px; color: #444; }
.sp__dlhist ul { margin: 4px 0 0 18px; }
.sp__badge.is-none { background: #5b6c7a; color: #fff; }    /* 灰：还没落过库（#94a3b8 上的白字只有 2.56） */
.sp__badge.is-saved { background: #15803d; color: #fff; }   /* 绿：与服务端一致 */

.sp__mask {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45);
  display: flex; align-items: center; justify-content: center; z-index: 40;
}
.sp__modal {
  width: min(1000px, 94vw); max-height: 88vh; overflow: auto;
  background: #fff; color: #111; border-radius: 10px; padding: 16px 18px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
}
.sp__head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.sp__now { color: #555; font-size: 13px; }
.sp__online { color: #15803d; font-size: 12px; }
.sp__offline { color: #b91c1c; font-size: 12px; }

.sp__form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: end; }
.sp__form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #444; }
.sp__input {
  padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px;
}
.sp__actions { grid-column: 1 / -1; display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }

.sp__err {
  margin: 10px 0 0; padding: 8px 10px; border-radius: 6px;
  background: #fef2f2; color: #b91c1c; font-size: 13px;
}
.sp__conflict {
  margin: 10px 0 0; padding: 10px 12px; border-radius: 6px;
  background: #fffbeb; border: 1px solid #fcd34d; font-size: 13px;
}

.sp__table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 13px; }
.sp__table th {
  text-align: left; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-weight: 600;
}
.sp__table td { padding: 6px 8px; border-bottom: 1px solid #f1f5f9; }
.sp__table tr.is-current { background: #eff6ff; }
.sp__row-actions { display: flex; gap: 6px; }
.sp__empty { text-align: center; color: #64748b; padding: 18px 0; }
.mono { font-variant-numeric: tabular-nums; }
/* 服务端复核（R4-3）：判定权在服务端、交互反馈在本地 —— 两边的数并排放，一致才安心 */
.sp__verify { display: flex; align-items: center; gap: 7px; margin: 6px 0 9px; font-size: 11.5px; color: #475569; flex-wrap: wrap; }
.sp__vdot { width: 7px; height: 7px; border-radius: 50%; background: #94a3b8; flex: 0 0 auto; }
.sp__vdot.is-ok { background: #16a34a; }
.sp__vdot.is-bad { background: #dc2626; }
.sp__vstale { color: #b45309; }
.sp__audit { white-space: nowrap; }
.sp__tag { display: inline-block; padding: 1px 5px; border-radius: 4px; font-size: 10.5px; margin-right: 4px; }
.sp__tag.is-warn { background: #fef3c7; color: #92400e; }
.sp__tag.is-bad { background: #fee2e2; color: #991b1b; }
.sp__tag.is-ok { background: #dcfce7; color: #166534; }
.sp__tag.is-muted { color: #94a3b8; }
</style>