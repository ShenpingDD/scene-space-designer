/**
 * paramsText.js —— 参数相关**给人看的那几句话**（R6-4 B4b）
 *
 * ## 为什么单独一个文件
 * 「现在按哪一版在算」这句话，设计器顶栏要说、维护端参数页要说、自动跟新的提示还要说。
 * 三处各写一份的代价很具体：同一件事慢慢长成三种说法，而且**不会报错** ——
 * 只是有人看到"服务端那一版"、有人看到"后台改的"，然后开始怀疑参数到底生效没有。
 * 所以整句**只有这一个出处**（与 `admin/schemes.js` 里那些文案函数同一套路）。
 *
 * 纯函数、不 import 内核 → 能被 `node --test` 跑（`app/test/params-text.test.js`）。
 */

/**
 * 「现在按哪一版在算」。
 *
 * ⚠️ 两种状态都必须说得**不含糊**：
 *   - 装上了：说"服务端那一版"，并带上 rev；
 *   - 没装上：必须说"代码里的默认值"，**并且不许把本地算出来的指纹说成"服务端那一版"**
 *     （本地指纹永远算得出来，but 它跟服务端有没有那份没关系 —— 混起来就是骗人）。
 */
export function liveLine(live, rev) {
  const L = live || {};
  if (L.source === 'server') {
    return '规则参数：服务端那一版（rev ' + (L.rev == null ? '?' : L.rev) + '）'
      + (Array.isArray(L.ignored) && L.ignored.length ? '，' + L.ignored.length + ' 项没被采用' : '');
  }
  return '规则参数：代码里的默认值'
    + (L.error ? '（取服务端那份失败：' + L.error + '）' : '')
    + (rev == null ? '' : '（本地算出来是 rev ' + rev + '，与服务端无关）');
}

/**
 * 参数**自动**换了之后要说的话。
 *
 * 这一句是"界面必须说真话"里最要紧的一句：判定标准中途变了、现场结论跟着变，
 * 而用户完全不知道脚下发生了什么。所以它必须说**三件事**：
 * ① 后台改了参数；② 现在已经按新的算；③ 是几秒内自己跟上的（不是他刷新出来的）。
 */
export function autoLine(event, watchMs) {
  const secs = Math.max(1, Math.round((watchMs || 5000) / 1000));
  if (!event || event.kind !== 'updated') {
    return '后台改了参数，但这版没装上：现在还在按上一版算（原因：'
      + ((event && event.reason) || '未知') + '）';
  }
  return '后台改了规则参数，已在 ' + secs + ' 秒内自动跟上：现在的判定按 rev '
    + (event.rev == null ? '?' : event.rev) + ' 走。';
}

/** 维护端参数页顶部那句「这一版是谁、改过几项」 */
export function originLine(origin, changed) {
  if (!origin) return '';
  return changed > 0 ? (origin + '：有 ' + changed + ' 项不是出厂值') : origin;
}