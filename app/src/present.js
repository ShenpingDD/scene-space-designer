/**
 * present.js —— 面客模式（`/view/<口令>`）的**话术与形状**（纯函数，零 DOM）
 *
 * ## 为什么把话术从组件里搬出来
 * 面客模式的每一句话都是**给客户**看的：他对这份方案没有上下文，也不能执行我们的命令。
 * 所以这里的规矩是 —— **每一句话都要能被客户执行**（能做什么、找谁），
 * 不是给工程师的下一步（`View3D.vue` 里那句 `cd tools/models && npm run extract` 就是反例）。
 *
 * 这条规矩写成注释就只能靠人记得。搬成纯函数之后：**单测能扫**（`DEV_ONLY_WORDS`）、
 * **真机探针能扫**（页面上不许出现那些命令）。规矩一旦能被机器判，才活得过下一次重构。
 *
 * ## 与 `share.js` 的分工
 * `share.js` = 设计者那一侧（链接、口令掩码、天数、网络提示）；
 * 这里 = 客户那一侧（信息条、状态话、操作提示）。两边都纯，都能单测。
 */


/**
 * **只给开发者看的下一步命令** —— 面客模式的任何一句话里都不许出现。
 *
 * 判据两处都用它：`app/test/present.test.js`（扫本模块产出的每一个字符串）、
 * 真机探针（扫页面上真实渲染出来的文字）。加新命令时只加这一处。
 */
export const DEV_ONLY_WORDS = [
  'cd tools/',
  'npm run',
  'npm --prefix',
  'node tools/',
  '/assets/optimized',
  '.glb',
];

/**
 * 扫描一段文字里有没有"给开发者的话"。
 * @returns {string[]} 命中的词（空数组 = 干净）
 */
export function devOnlyHits(text) {
  const s = String(text == null ? '' : text);
  return DEV_ONLY_WORDS.filter((w) => s.includes(w));
}

/**
 * 信息条（44 px）要说清的三件事：**这是什么 / 多少台 / 只读**。
 *
 * 「多少台」拿不到就说「— 台设备」，**不写 0**：0 台是一句关于方案的话（"这份是空的"），
 * 而读不到是一句关于这次读取的话。把读不到说成 0 台，就是拿一个假事实顶上一个真空白。
 */
export function barText({ name, count, roomCount = 0, focusedRoom = '' } = {}) {
  const raw = String(name == null ? '' : name).trim();
  const n = Number(count);
  const rooms = Number(roomCount);
  const focused = String(focusedRoom == null ? '' : focusedRoom).trim();
  return {
    name: raw || '（没有名字）',
    // 多房间时才报房间数（一间房时"1 间"是废话）；聚焦了哪一间就顺口说出来 ——
    // 客户点了半天，界面上得有一句告诉他"现在看的是这一间"。
    countText: [
      Number.isFinite(n) && n >= 0 ? `${n} 台设备` : '— 台设备',
      Number.isFinite(rooms) && rooms > 1 ? `${rooms} 间房` : '',
    ].filter(Boolean).join(' · '),
    focusedText: focused ? `已聚焦「${focused}」` : '',
    badge: '只读',
  };
}

/**
 * 面客页的点击提示（**客户话**）：多房间时告诉他能点房间 —— 不然谁会去试点地板。
 * 一间房时不出现（没有第二间可切，那句话只会让人白点一下）。
 */
export function roomHint(roomCount = 0, { coarse = false, focused = '' } = {}) {
  const n = Number(roomCount);
  if (!(n > 1)) return '';
  const act = coarse ? '点一下房间' : '点击房间';
  return focused
    ? `${act}可切到别间 · 想去看看就点「第一人称」，会站在这一间里`
    : `${act}聚焦到那一间（多房间方案）`;
}


/**
 * 画布上那条状态提示（说不出来就 `null` —— 不编一句"一切正常"顶上）。
 *
 * 四种情况，两种性质：
 *   · **设备的问题**（模型没做好 / 没加载出来）→ `bad`，要客户**能做什么**：刷新、找分享人；
 *   · **方案本来就空** → 陈述句，不带情绪，也不劝他"去加一台"（他加不了，这是只读页）。
 *
 * @param {{items?:number, meshes?:number, errors?:number, missingAssets?:number, loading?:boolean}} s
 *   `items` 方案里的台数 · `meshes` 场景里已就位的台数 · `missingAssets` 目录里压根没有模型的台数
 */
export function presentNote(s = {}) {
  const items = Math.max(0, Number(s.items) || 0);
  const itemsKnown = Number.isFinite(Number(s.items));
  const meshes = Math.max(0, Number(s.meshes) || 0);
  const errors = Math.max(0, Number(s.errors) || 0);
  const missing = Math.max(0, Number(s.missingAssets) || 0);
  if (missing > 0) {
    return { kind: 'bad', text: `有 ${missing} 台设备的三维模型还没做好 —— 请联系给你链接的人。` };
  }
  if (errors > 0) {
    return { kind: 'bad', text: `有 ${errors} 台设备的三维模型没加载出来 —— 刷新试试；还是不行就请联系给你链接的人。` };
  }
  // ⚠️ 「这一份是空的」是一句**关于方案本身**的话 —— 台数没给就不许说（说了就是编一个事实）。
  if (!itemsKnown) return null;
  if (items === 0) return { kind: 'info', text: '这一份方案里还没有设备。' };
  if (meshes < items) return { kind: 'info', text: `正在载入模型…（${meshes}/${items}）` };
  return null;
}

/* ───────────────────── 虚拟摇杆（只在「第一人称 + 触摸屏」） ─────────────────────
 *
 * 这一段是**纯换算**：手指离摇杆中心的（dx, dy）→ 「前 / 右」两个量。
 *
 * 为什么它必须能单测：这里最容易错的是一条**符号**（推"上"到底是前还是后）——
 * 错了不报错、界面也能跑，客户只会觉得"摇杆反的"，而感觉说不清是哪条轴
 * （与 `spatial-core/src/walkbasis.js` 同一个教训）。真机上也只靠断言：
 * 探针推"上"，然后拿**相机基准**对账它真的在往前走。
 */

/** 摇杆半径（px）—— 真机上就是那个圈的大小 */
export const STICK_RADIUS_PX = 52;

/** 死区（px）：手指搭在摇杆上不推时不能走。没这个，一点点抖动就会让人慢慢飘 */
export const STICK_DEAD_PX = 7;

/**
 * 摇杆位移 → 「前 / 右」。
 *
 * @param {number} dx     手指相对摇杆中心的横向偏移（右为正）
 * @param {number} dy     手指相对摇杆中心的纵向偏移（**屏幕坐标，下为正**）
 * @param {number} radius 摇杆半径（px）
 * @param {number} deadPx 死区（px）
 * @returns {{fwd:number, right:number, mag:number, clustered:boolean}} `fwd` 为正 = 向前
 *
 * 三条规矩：
 *   ① **推上是向前**：屏幕 y 向下，所以 `fwd = −dy`。这就是那条最容易写反的符号；
 *   ② **推出去多少就走多快**（`mag ≤ 1`，线性），推到圈外**夹到圈** —— 拖远不许更快；
 *   ③ 死区之内一律 0（连 `mag` 也是 0：界面要能把"手搭上了但没推"与"真的在推"分开）。
 */
export function stickVector(dx, dy, radius = STICK_RADIUS_PX, deadPx = STICK_DEAD_PX) {
  const r = Math.max(1, Number(radius) || 0);
  const x = Number(dx) || 0;
  const y = Number(dy) || 0;
  const len = Math.hypot(x, y);
  if (!(len > Math.max(0, Number(deadPx) || 0))) {
    return { fwd: 0, right: 0, mag: 0, clustered: false };
  }
  const out = len > r;
  const k = (out ? r : len) / len;
  return {
    fwd: -(y * k) / r,
    right: (x * k) / r,
    mag: out ? 1 : len / r,
    clustered: out,
  };
}

/** 「这个屏幕是手指还是鼠标」—— 提示词与摇杆都看它（触摸屏上走动靠摇杆）。 */
export function isCoarsePointer(win = globalThis) {
  const mq = win?.matchMedia;
  if (typeof mq !== 'function') return false;
  try {
    return !!mq('(pointer: coarse) and (hover: none)').matches;
  } catch (e) {
    return false;
  }
}

/**
 * 操作提示：**两种视角 × 两种输入**，共四句。
 *
 * 触摸屏上不加"走动要键盘"这句的话，客户会以为自己操作不对（实际是这台设备没有键盘输入）。
 */
export function viewHint(view, { coarse = false } = {}) {
  if (view === 'walk') {
    return coarse
      ? '左下摇杆走动 · 拖动画面转头 · 想回鸟瞰就点上面的按钮'
      : 'W A S D / 方向键 走动 · Shift 快走 · 按住左键拖动环视 · Esc 回鸟瞰';
  }
  return coarse
    ? '单指拖动旋转 · 双指拖动平移 · 捏合缩放'
    : '左键拖动旋转 · 右键拖动平移 · 滚轮缩放';
}

/**
 * 第一人称里「推不动」这件事必须说出来（FIX-17：嵌在几何体里时界面不许静默）。
 *
 * 内核把 `stuck` 放在探针里（`probe().camera.stuck`），界面只负责把它转成一句**能执行的话**：
 * 告诉客户"过不去"和"换个方向"——不是一句"碰撞已触发"。只在真的置位时出现。
 */
export function walkNote(stuck) {
  return stuck ? { kind: 'bad', text: '这里过不去 —— 前面有设备或墙，换个方向试试。' } : null;
}

/**
 * 链接不能用时的**第一句话**（三种"不能用"给三种话 —— 下一步动作完全不同）。
 *
 * 服务端已经把 `reason` 分了类（`share-expired` / `share-revoked` / `not-found`，
 * 见 `Share.codeOf`），这里只负责把它翻成客户看得懂的一句。**不自己另判一套**。
 */
export function shareErrorTitle(reason) {
  switch (String(reason || '')) {
    case 'share-expired': return '这条分享链接已经过期';
    case 'share-revoked': return '这条分享链接已经被撤销';
    case 'not-found': return '这个分享口令对不上';
    default: return '读不到这份分享';
  }
}

/** 链接不能用时**统一**的下一步（三种情况都成立：只能找分享人） */
export const SHARE_ERROR_NEXT = '下一步：找发链接给你的人要一条新的（口令只能原样比对 —— 猜是猜不出来的）。';

/* ── 链接不能用时的呈现方式（放在后面：它依赖上面的标题与下一步文案） ── */

/**
 * 客户那一页上**不需要**的辅助文字清单（2026-10-08 用户拍板删掉的原文）。
 *
 * 为什么写成常量而不是"删了就完事"：删掉的字**会回来**（换个模板、拷一份旧代码、
 * 有人觉得"多说一句没坏处"）。写成一张机器能扫的表 —— 单测扫本模块产出的每一个字符串、
  * 真机探针扫页面上真实渲染出来的文字 —— 它就回不来了。
 */
export const BANNED_ON_CLIENT_PAGE = [
  '这是只读分享',
  '看到的是【当前】内容',
  '要改方案，请联系发链接给你的人',
];

/**
 * 链接不能用时的**呈现方式**（2026-10-08 用户拍板）。
 *
 * 他原话："如果分享链接已撤销，你只需要在全屏展示『这条分享链接已经被撤销』
 * 这样一句话文案就好了，不需要有最顶端的导航，也不需要有小字说明。"
 *
 * 所以分两种：
 *   · **撤销 / 过期**：全屏**一句话**（没有信息条、没有画布、没有小字）——
  *     这两件事"没什么可操作的"，多说一句都是噪声；
 *   · **口令对不上 / 读不到**：标题 + **一行**下一步。这种多半是链接被截断/敲错了，
 *     什么都不说客户会以为"网站坏了"。
 *
 * 判据必须**双向**：撤销页面上**不许**出现信息条，也不能把"读不到"当成"已撤销"。
 */
export function shareErrorPage(reason) {
  const r = String(reason || '');
  // 这两件事"没什么可操作的"，一句话就够
  if (r === 'share-revoked' || r === 'share-expired') {
    return { bare: true, title: shareErrorTitle(r), lines: [], showDetail: false };
  }
  // 这三种是服务端分好类的（每种的下一步动作不一样）：标题 + 一行
  if (r === 'not-found') {
    return { bare: false, title: shareErrorTitle(r), lines: [SHARE_ERROR_NEXT], showDetail: false };
  }
  // 剩下的是"没料到的那种"：服务端那句话是**唯一的线索**，必须留着（不许为了少写字把它吞掉）
  return { bare: false, title: shareErrorTitle(r), lines: [SHARE_ERROR_NEXT], showDetail: true };
}
