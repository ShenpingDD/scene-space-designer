/**
 * case-runner.js —— 用例表执行器（**无运行环境依赖**）
 *
 * `test/cases/rules.json` 这张表要能在三个地方跑同一份实现：
 *   ① Node 断言（`npm test`）
 *   ② 浏览器里的应用（`window.__spatial.parity()` —— 证明界面用的就是被断言的那份规则）
 *   ③ 将来 Java 侧（照这张表与这里定义的语义，逐条复现）
 *
 * 所以它不能引用 node:test、node:fs，也不能依赖 DOM。
 * 输入：用例表 + 内核模块；输出：每条用例的实际结果。
 */

import { cloneWall, readWall } from './wall.js';

export const RULES = [
  'validate',
  'validate-wall',
  'room-resize',
  'placement',
  'scheme-roundtrip',
  'scheme-accept',
  'scheme-errors',
  'door',
  'door-clearance',
  'collision',
  'collision-spawn',
];

/**
 * @param {object} table 用例表（`test/cases/rules.json` 的内容）
 * @param {object} kernel { room, validate, placement, scheme, doors, collision }
 * @param {(id:string)=>object} kernel.getProduct
 * @returns {Array<{id, rule, why, actual, expect, ok, mismatches}>}
 */
export function runCases(table, kernel) {
  const { room, validate, placement, scheme, doors, clearance, collision, getProduct } = kernel;

  const layoutOf = (c) => ({
    w: c.room.w,
    d: c.room.d,
    h: c.room.h ?? 2.8,
    // 墙一律归一化成**对象**（与方案文件同一个读法：`readWall` 宽容、`cloneWall` 唯一）。
    // 用例表里的 `walls` 写的是对象（W1 门洞起）；写成老式数组也能被宽容地读进来。
    walls: (c.walls ?? []).map((w) => cloneWall(readWall(w) ?? w)),
    items: (c.items ?? []).map((i) => ({ ...i })),
    // 视图档位（可选）—— 走的是方案状态，所以要能进得去、也要能被断言
    ...(c.view ? { view: { ...c.view } } : {}),
    // 房间名（可选，M1a）：与视图档位同一个位置（都在 state 里、都要能往返）
    ...(c.roomLabels ? { roomLabels: { ...c.roomLabels } } : {}),
  });

  const runners = {
    validate: (c) => {
      const body = layoutOf(c);
      body.items = body.items.filter((i) => i.id !== c.item.id);
      return { reason: validate.checkItem(body, c.item, getProduct) };
    },

    // 墙越界（B19）：墙没有 id，所以返回的是**序号**清单 —— 与 2D 的 data-wall-index 同一套编号
    'validate-wall': (c) => ({ badWalls: validate.checkAllWalls(layoutOf(c)) }),

    'room-resize': (c) => {
      const r = room.applyRoomSize(layoutOf(c), c.next);
      return r.ok
        ? {
          ok: true, kept: r.kept, removed: r.removed, wallCount: r.layout.walls.length,
          firstWall: r.layout.walls[0],
          // 门洞读数（W1）：墙是对象，门洞是墙的字段 —— 改尺寸时**跟着走**还是**放不下丢掉**，
          // 两个数都要能被断言（许静默丢就是许丢数据）
          openingsKept: r.openingsKept ?? 0,
          openingsDropped: r.openingsDropped ?? 0,
          // 窗读数（W2）：**"窗还在不在"必须是可断言的** —— 只数洞口个数的话，
          // 窗被降级成落地洞（`room.js` 那处手抄 `{at,w,h}` 的窄门）照样是 1，判据会假绿。
          // 与 Java `CaseRunner` 同名同口径。
          windowCount: r.layout.walls.reduce(
            (n, w) => n + (w.openings ?? []).filter((o) => o.kind === 'window').length, 0),
        }
        : { ok: false, error: r.error };
    },

    placement: (c) => {
      let body = layoutOf(c);
      if (c.fillTo) {
        for (let i = 0; i < c.fillTo; i++) {
          const step = placement.addItem(body, c.product, { getProduct });
          if (!step.ok) return { ok: false, reason: step.reason, filled: i };
          body = step.layout;
        }
      }
      const r = placement.addItem(body, c.product, { getProduct });
      return r.ok ? { ok: true, x: r.item.x, z: r.item.z } : { ok: false, reason: r.reason };
    },

    'scheme-roundtrip': (c) => {
      const a = scheme.exportScheme(layoutOf(c));
      const r = scheme.importScheme(a, { getProduct });
      if (!r.ok) return { ok: false, reason: r.reason };
      // styleOut = **过完一轮之后还在不在**（认不得的档位两侧都该丢掉）
      // openingCount = 同上，说的是门洞：服务端的 state 是字段白名单，**漏一个就静默消失**
      return {
        ok: true,
        identical: scheme.exportScheme(r.layout) === a,
        styleOut: r.layout.view?.wallOpacity ?? null,
        openingCount: r.layout.walls.reduce((n, w) => n + (w.openings?.length ?? 0), 0),
        // M1a 房间名：与 openingCount 同一个理由 —— 服务端 `stateOf` 是**字段白名单**，
        // 漏掉 `roomLabels` 就会在"保存 → 分享 → 交付"链上无警告消失（FIX-05 的病因）。
        roomLabelCount: Object.keys(r.layout.roomLabels ?? {}).length,
        nextId: r.nextId,
        format: r.format,
      };
    },

    'scheme-accept': (c) => ({
      allOk: c.formats.every((f) => scheme.importScheme({ format: f, state: { w: 8, d: 6, h: 2.8, walls: [], items: [] } }, { getProduct }).ok),
    }),

    'scheme-errors': (c) => {
      const F = 'scene-space-designer';
      const make = (kind) => ({
        'not-json': '{oops',
        'bad-format': { format: 'other', state: {} },
        'bad-room': { format: F, state: { w: 99, d: 6, h: 2.8, walls: [], items: [] } },
        'too-many-walls': { format: F, state: { w: 8, d: 6, h: 2.8, walls: new Array(101).fill([0, 0, 1, 0]), items: [] } },
        'duplicate-id': { format: F, state: { w: 8, d: 6, h: 2.8, walls: [], items: [{ id: 1, p: 'demo-cabinet-800', x: 1, z: 1, r: 0 }, { id: 1, p: 'demo-cabinet-800', x: 4, z: 1, r: 0 }] } },
        // ⚠️ 这本来是一条**斜墙**([0,0,8,3]) —— 斜墙合法之后它就不再是坏样本了（用例当场红，
        // 这正是「契约自己也要有断言」的价值）。改成「太短」：0.05 m < 下限 0.1 m。
        'bad-wall': { format: F, state: { w: 8, d: 6, h: 2.8, walls: [[0, 0, 0.05, 0]], items: [] } },
      }[kind]);
      return { exact: c.samples.every((s) => scheme.importScheme(make(s.bad), { getProduct }).reason === s.reason) };
    },

    door: (c) => ({ rotation: doors.hingeRotation(c.hinge, c.amount) }),

    // 规则 7 开门净空（接缝 A 的 A3 决策）：只报"最多能开多少"，不阻断放置
    'door-clearance': (c) => {
      const body = layoutOf(c);
      const subject = body.items.find((i) => i.id === c.item.id);
      const r = clearance.doorFreeAngle(body, subject, getProduct);
      return {
        freeDeg: r.freeDeg,
        maxDeg: r.maxDeg,
        level: clearance.clearanceLevel(r.freeDeg),
        unobstructed: r.unobstructed,
        door: r.door,
        blockedKind: r.blockedBy?.kind ?? null,
        blockedId: r.blockedBy?.id ?? null,
      };
    },

    collision: (c) => ({ blocked: collision.blocked(c.point[0], c.point[1], layoutOf(c), getProduct) }),

    'collision-spawn': (c) => {
      const body = layoutOf(c);
      const spawn = collision.safeSpawn(body, getProduct);
      return { spawnIsFree: Array.isArray(spawn) && !collision.blocked(spawn[0], spawn[1], body, getProduct) };
    },
  };

  return table.cases.map((c) => {
    const run = runners[c.rule];
    let actual;
    let mismatches = [];
    if (!run) {
      mismatches = [`未知规则 ${c.rule}`];
      actual = null;
    } else {
      try {
        actual = run(c);
      } catch (err) {
        actual = { error: String(err?.message ?? err) };
        mismatches.push(`抛错：${actual.error}`);
      }
      for (const [k, v] of Object.entries(c.expect)) {
        if (JSON.stringify(actual?.[k]) !== JSON.stringify(v)) {
          mismatches.push(`${k}: 期望 ${JSON.stringify(v)}，实际 ${JSON.stringify(actual?.[k])}`);
        }
      }
    }
    return { id: c.id, rule: c.rule, why: c.why, actual, expect: c.expect, ok: mismatches.length === 0, mismatches };
  });
}

/** 汇总（给界面/日志用的一句话） */
export function summarize(results) {
  const failed = results.filter((r) => !r.ok);
  return {
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    failedIds: failed.map((r) => r.id),
  };
}