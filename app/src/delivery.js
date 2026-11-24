/**
 * delivery.js —— 交付包这一侧的**纯逻辑**（B7 / R6-5）
 *
 * 这里不放任何"界面长什么样"的东西（那是 `SchemePanel.vue` 的事），也**不抄**服务端的对照表：
 *   · 有哪些件可勾、每件叫什么、会落在哪些文件里 —— 全部来自 `GET /api/schemes/{id}/deliveries`
 *     的 `items`（唯一出处是服务端 `Delivery.ITEMS`）。抄一份到前端，就会在改词表那天漏掉一边。
 *   · 这里只有"把勾选拼成请求""核对包里到底有没有"这类**算得出来的**事。
 *
 * 三个固定视角的**顺序**是唯一必须与后端对齐的东西，它在 `views3d.js` 里，两边注释互相指着。
 */

import { SHOT_VIEWS } from './views3d.js';
import { roomAt } from '@core/rooms.js';
import { roomSummary } from '@core/rooms.js';

/** 勾选名单：默认全部勾上；可选附件（GLB）默认**不勾**（决策⑧：体积大） */
export function defaultSelection(items) {
  return (items || []).map((i) => i.id);
}

/**
 * 拼请求体（并在这里挡住"三张图不齐"这种一眼可见的错）。
 *
 * `expectRev` 是硬要求：**包要钉在某一版上**。少它就是"不知道打的哪一版"——
 * 而那种包事后对账对不出来，等于没打过。
 */
/**
 * 每台设备在哪一间（M1 多房间）—— **派生的**，给服务端写进「设备清单.csv」的房间列。
 *
 * 为什么在这一侧算：房间是墙剖出来的派生面，那段面遍历在 JS 内核里只有一份
 * （`spatial-core/src/rooms.js`）；为了清单上的一列把它在 Java 侧再写一遍，是本项目最贵的教训。
 * 中心点落在墙上、或在整栋之外时**如实写「未分房间」**（与内核 `roomAt` 的 null 同一口径），
 * 不猜、不留空 —— 空格子会被施工队当成"这一格漏画了"。
 */
export function roomMapOf(layout) {
  const names = new Map(roomSummary(layout, layout.roomLabels).map((r) => [r.id, r.displayName]));
  const out = {};
  for (const it of layout.items ?? []) {
    const room = roomAt(layout, it.x, it.z);
    out[String(it.id)] = room ? (names.get(room.id) ?? '未分房间') : '未分房间';
  }
  return out;
}

export function buildRequest({ rev, items, withAssets, note, planSvg, shots, rooms }) {
  if (rev === null || rev === undefined || rev === '') {
    throw new Error('这一份方案还没有版本号（没保存过？）—— 先保存一次再打交付包');
  }
  const list = shots || [];
  if (list.length !== SHOT_VIEWS.length) {
    throw new Error(`三维截图要正好 ${SHOT_VIEWS.length} 张（${SHOT_VIEWS.map((v) => v.label).join('、')}），`
      + `现在只有 ${list.length} 张 —— 三维视图没准备好？`);
  }
  return {
    expectRev: Number(rev),
    items: items || [],
    withAssets: !!withAssets,
    note: note || '',
    planSvg: planSvg || '',
    shots: list,
    // 房间列（可选但**总是给**）：一台设备一行房名，缺了就写「未分房间」
    rooms: rooms || {},
  };
}

/**
 * 「勾了、但包里没有」的那几件。
 *
 * 为什么要专门算这一件事：**少一件的包，长得和齐的包一模一样**。
 * 交付团队不会知道少了封面（少一张图 vs 本来就没有封面，从文件列表上看不出来）——
 * 所以打包完必须当场把差异说出来（README 里也写着同一份差异）。
 *
 * @param {string[]} selected 勾选的件 id
 * @param {object[]} items    服务端下发的件清单（每条带 `files`：这一件会落哪些文件名）
 * @param {object[]} files    实际落在包里的文件（`scheme_delivery.files_json`）
 */
export function missingOf(selected, items, files) {
  const have = new Set((files || []).map((f) => f.name));
  const out = [];
  for (const id of selected || []) {
    const it = (items || []).find((x) => x.id === id);
    if (!it) continue;
    const names = it.files || [];
    const absent = names.filter((n) => !have.has(n));
    if (absent.length) out.push(`${it.label}（包里没有：${absent.join('、')}）`);
  }
  return out;
}

/** 包里文件的合计大小（界面上要写"这一包 3.2 MB"） */
export function totalBytes(files) {
  return (files || []).reduce((n, f) => n + (Number(f.bytes) || 0), 0);
}

/** 人读的大小（与 README、服务端 `Delivery.human` 同一套口径） */
export function human(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

/**
 * 交付流转状态的中文 —— **不在这里另写一份**，直接复用维护端那一份（`admin/schemes.js`）。
 *
 * 一开始这里写了个自己的映射表（draft→「未交付」），而维护端早就有一份（draft→「草稿」，
 * 拍板⑤：只有 draft / delivered 两档）—— 于是同一个状态在设计器里叫「未交付」、
 * 在方案库里叫「草稿」。**同一个概念两个词**，比任何一处写错都更难纠正（人会以为是两件事）。
 * 所以改成 re-export：**一处定义，两处显示**。
 */
export { statusLabel } from './admin/schemes.js';

/** 已交付的方案再动内容时，界面上要提醒的那句话（**不是禁止**，是提醒） */
export function staleAfterEdit(status) {
  return String(status) === 'delivered'
    ? '这一份已经交付过了；改完记得重新打一版交付包（不然手上那份图纸与库里对不上）'
    : '';
}