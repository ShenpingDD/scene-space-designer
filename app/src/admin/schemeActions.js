/**
 * schemeActions.js —— 卡片上的四个写动作与版本历史（维护端方案库与「我的方案」共用）
 *
 * ## 为什么抽出来
 * 两页的按钮行为必须**一字不差**：同样是"删除进回收站"，一处弹确认框、另一处直接删，
 * 用户会认为其中一处是坏的。所以状态（`busy`/`confirming`/`notice`/`drawer`）与发请求那几下
 * 只有这一份实现，页面只提供"重新取数"这一个接口（两页取的接口不同）。
 *
 * ## 写库的动作不许安静
 * 成功也要说话，而且要说清**做了什么**（复制来自哪一份哪一版；回滚前那一版是本来就有、还是刚补存的）。
 * 话术由 `schemes.js` 的纯函数生成 —— 那些句子有判据盯着。
 */
import { ref } from 'vue';
import { api } from '../api.js';
import { go, schemeHref } from '../router.js';
import {
  duplicateDoneText, deleteDoneText, revisionOf, rollbackConfirmText, rollbackDoneText,
} from './schemes.js';

/** 失败要说清是哪一种失败：`reason` 是后端给的分流依据（rev-conflict / not-deleted / …） */
export function reasonText(e) {
  return (e && e.reason ? e.reason + '：' : '') + (e && e.message ? e.message : '未知原因');
}

/**
 * @param {Function} reload 重新取这一页的列表（两页各自实现）
 */
export function createSchemeActions(reload) {
  /** 正在写库的动作：`<动作>:<id>`。只关**相关**的按钮，不整页禁用（别的卡片还能用） */
  const busy = ref('');
  /** 二次确认：`{kind:'delete'|'rollback', id, ...}` | null */
  const confirming = ref(null);
  /** 上一次动作的结果。**成功也留着**（用户可能刚点完就去接电话了，回来看得见发生了什么） */
  const notice = ref(null);
  /** 展开的版本历史：同一时刻只展开一份 */
  const drawer = ref(null);

  const isBusy = (kind, id) => busy.value === kind + ':' + id;

  /** 四个动作都走这一个壳，保证"都说话、都刷新、都收尾" */
  async function act(kind, id, send, okText) {
    busy.value = kind + ':' + id;
    notice.value = null;
    try {
      const res = await send();
      notice.value = { kind: 'ok', text: okText(res) };
      confirming.value = null;
      // 回滚之后版本表已经变了，展开着的那份是**旧的** —— 留着它就是给人看错的东西
      drawer.value = null;
      await reload();
    } catch (e) {
      notice.value = { kind: 'bad', text: reasonText(e) };
    } finally {
      busy.value = '';
    }
  }

  function askDelete(id) {
    notice.value = null;
    confirming.value = { kind: 'delete', id };
  }

  function askRollback(card, rev) {
    notice.value = null;
    confirming.value = {
      kind: 'rollback',
      id: card.id,
      targetRev: rev.rev,
      expectRev: card.rev,
      // 确认话术冻结在"点下去的那一刻"：它必须说清回滚之后长什么样 + 当前那版会先自动留存
      text: rollbackConfirmText(rev, card.rev),
    };
  }

  const cancelConfirm = () => { confirming.value = null; };

  const doDelete = (id) => act('delete', id, () => api.deleteScheme(id), () => deleteDoneText(id, false));
  const doRestore = (id) => act('restore', id, () => api.restoreScheme(id), () => deleteDoneText(id, true));
  const doDuplicate = (id) => act('duplicate', id, () => api.duplicateScheme(id), (res) => duplicateDoneText(res));
  const doRollback = (id, targetRev, expectRev) => act('rollback', id,
    () => api.rollbackScheme(id, targetRev, expectRev), (res) => rollbackDoneText(res));

  async function toggleHistory(card) {
    if (drawer.value && drawer.value.id === card.id) {
      drawer.value = null;
      return;
    }
    notice.value = null;
    confirming.value = null;
    drawer.value = { id: card.id, phase: 'loading', rows: [], currentRev: card.rev, trouble: '' };
    try {
      const list = await api.revisions(card.id);
      drawer.value = {
        id: card.id,
        phase: 'ok',
        rows: (Array.isArray(list) ? list : []).map(revisionOf),
        currentRev: card.rev,
        trouble: '',
      };
    } catch (e) {
      drawer.value = { id: card.id, phase: 'fail', rows: [], currentRev: card.rev, trouble: reasonText(e) };
    }
  }

  function resetTransient() {
    confirming.value = null;
    drawer.value = null;
    notice.value = null;
  }

  function openInDesigner(id) {
    const href = schemeHref(id);
    if (href) go(href);
  }

  return {
    busy, confirming, notice, drawer,
    isBusy, askDelete, askRollback, cancelConfirm,
    doDelete, doRestore, doDuplicate, doRollback,
    toggleHistory, resetTransient, openInDesigner,
  };
}
