/**
 * legacyGate —— 旧方案「转为开放场景」的**放行/阻断决策**（P4 / docs/93 §4.2）。
 *
 * 为什么单独一个文件：`app/` 没有 Vue 渲染测试器（依赖里没有 @vue/test-utils），
 * 组件内部的判断只能靠"读源码字符串"来钉，钉不住真正会坏的那条路。把决策抽成纯函数后，
 * `app/test/legacy-convert-ui.test.js` 能直接跑它 —— 2026-10-22 这里就出过一个死循环：
 * 用户点「转为开放场景并保存」后 `save()` 再进预检仍读到 lossy，于是**永远存不进去**。
 *
 * 三条不能动的规矩：
 *   ① `lossy` 就阻断（不许静默少房间），由调用方把两条出路摆在界面上；
 *   ② 拿不到报告（内核没接线 / 抛错 / `ok:false`）一律 **fail-closed**：宁可挡住，也不放行；
 *   ③ 用户明确同意过的那一次要放行，而且同意**只生效一次**（`consumeConsent`，读完即清）——
 *      保存失败或布局又改了，都不能留下"以后都放行"。
 *
 * 判据本身不在这个文件里：`read()` 必须是对内核 `scheme.legacyConvertReport(layout)` 的调用，
 * 界面不重算几何、不自己数房间（docs/91 §6.7「不静默」与 AGENTS §5「判据只在自己适用的条件下发声」）。
 */

/** 决策动作（ASCII 代码，界面/测试都按它分流；中文只在话术里出现） */
export const LEGACY_GATE = { PROCEED: 'proceed', BLOCK: 'block' };

/**
 * @param {object} input
 * @param {string} input.semantics 当前方案语义（`legacy` | `walls`，来自 `d.schemeMeta.roomSemantics`）
 * @param {boolean} [input.consent] 用户是否刚明确点过「转为开放场景」
 * @param {() => object|null} [input.read] 取内核预检报告；返回 `null` = 内核没接线
 * @returns {{action:string, consumeConsent?:boolean, reason?:string, message?:string, report?:object|null}}
 */
export function legacyGate({ semantics, consent = false, read = null } = {}) {
  // 新方案：没有"转换"这回事，连问都不必问
  if (semantics !== 'legacy') return { action: LEGACY_GATE.PROCEED, consumeConsent: false };
  // 用户刚点过同意：这一次放行，并且把同意**用掉**（一次性；见头注 ③）
  if (consent) return { action: LEGACY_GATE.PROCEED, consumeConsent: true };

  let report = null;
  let error = '';
  try {
    report = typeof read === 'function' ? read() : null;
  } catch (err) {
    error = String((err && err.message) || err);
  }
  if (error) {
    return {
      action: LEGACY_GATE.BLOCK,
      reason: 'legacy-bad-layout',
      report: null,
      message: '这份旧方案没能完成转换预检：' + error,
    };
  }
  if (!report) {
    // fail-closed：内核预检没接上就不存（放行 = 静默少房间）
    return {
      action: LEGACY_GATE.BLOCK,
      reason: 'legacy-no-preflight',
      report: null,
      message: '旧方案转换预检没有接入：为免静默少房间，这一次没有保存',
    };
  }
  if (report.ok === false) {
    return {
      action: LEGACY_GATE.BLOCK,
      reason: 'legacy-bad-layout',
      report,
      message: '这份旧方案没能完成转换预检：' + (report.error || '原因未知'),
    };
  }
  if (report.lossy) {
    const fewer = Math.max(0, (report.roomsBefore ?? 0) - (report.roomsAfter ?? 0));
    const lost = Array.isArray(report.droppedLabelNames) ? report.droppedLabelNames.filter(Boolean) : [];
    const message = `这份旧方案有 ${fewer} 间房依赖矩形外框，转成开放场景后会少；`
      + (lost.length ? `房间名「${lost.join('」「')}」会先挂起（墙围回去就回来）` : '房名会保留在方案里');
    return {
      action: LEGACY_GATE.BLOCK,
      reason: 'legacy-lossy',
      report: { ...report, fewer, lost },
      message,
    };
  }
  // 无损：放行，但**不**记同意 —— 用户没做过选择，下一次预检照常问
  return { action: LEGACY_GATE.PROCEED, consumeConsent: false };
}
