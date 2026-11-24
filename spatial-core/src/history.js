/**
 * history.js —— 撤销 / 重做（快照必然携带 nextId）
 *
 * 存在的唯一理由：原型 `snapshot()` 只存 `state`，而导入时 `nextId = max(id)+1`，
 * 于是「导入 → 撤销 → 新增」会**与旧状态撞 id**；撞完再导出，自己的文件又导不回来。
 * R1 修了它（FIX-25）；这里把"快照必须含 nextId"固化成**绕不过去的结构**，
 * 并补上原型没有的重做（新版 UI 会用到）。
 */
import { cfg } from './params.js';

// 参数见 params.js（原常量 MAX_STEPS）：cfg.history.maxSteps

export function createHistory() {
  let past = [];
  let future = [];

  const pack = (layout, nextId) => JSON.stringify({ s: layout, n: nextId });
  const unpack = (snap) => {
    const d = JSON.parse(snap);
    return { layout: d.s ?? d, nextId: Number.isFinite(d.n) ? d.n : null };
  };

  return {
    /** 记录当前状态（未记录时不可撤销） */
    push(layout, nextId) {
      past.push(pack(layout, nextId));
      if (past.length > cfg.history.maxSteps) past.shift();
      future = [];
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    /** 撤销：返回上一状态（含 nextId） */
    undo(layout, nextId) {
      if (!past.length) return null;
      future.push(pack(layout, nextId));
      return unpack(past.pop());
    },
    redo(layout, nextId) {
      if (!future.length) return null;
      past.push(pack(layout, nextId));
      return unpack(future.pop());
    },
    clear() { past = []; future = []; },
    size: () => past.length,
  };
}