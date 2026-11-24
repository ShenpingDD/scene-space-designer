/**
 * rooms.test.js —— M1 多房间：派生房间 / 墙三值 / 房间名 / 两个新手势
 *
 * 每条判据都写清**变异点**（怎么改代码会让它变红）—— 本项目规矩：
 * 「永远绿的用例比没有用例更坏」。凡是"成对才有意义"的（能过 / 仍挡、白名单里有没有字段），
 * 两条必须都在场：只留一条的话，功能整个坏掉也全绿。
 *
 * 口径（`docs/60` §3.1 / 用户 2026-10-09 四条拍板）：
 *  · 房间是**派生**的：真源只有墙，`rooms` 永不进 state；
 *  · 房面按墙**中心线**（零宽）：所以"所有房面面积之和 == 整栋 w×d"是一条硬判据；
 *  · 墙三值：外墙（一侧在整栋外）/ 隔墙（两侧是不同的房）/ 房内隔断（两侧同一间）；
 *  · 房间名：**可选**字段，键 = 几何稳定 id（顶点集合散列，与遍历顺序无关）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cfg, resetParams, configure } from '../src/params.js';
import { boundaryWalls, createLayout } from '../src/room.js';
import { checkItem, checkAllWalls, REASON, WALL_REASON } from '../src/validate.js';
import { blocked } from '../src/collision.js';
import { placeOpening } from '../src/openings.js';
import { exportScheme, importScheme } from '../src/scheme.js';
import {
  roomsOf, roomAreaTotal, roomAt, wallAdjacency, wallClasses, roomSummary, roomThumb,
  roomOutlineWalls, planSplit, carryLabels, cleanRoomName, readRoomLabel, cleanRoomLabels,
  ringId, DEFAULT_ROOM_NAME, JOIN_TOL_M,
} from '../src/rooms.js';

const W = (x, z, xx, zz, openings) => ({ a: [x, z], b: [xx, zz], ...(openings ? { openings } : {}) });
const P = { w: 1.2, d: 1.1, h: 1.99, model: 'demo-cabinet-800', doors: [] };
const getProduct = (id) => (id === 'demo-cabinet-800' ? P : undefined);

/** 8×6 的整栋 + 可选内墙 */
const box = (extra = [], w = 8, d = 6) => ({ w, d, h: 2.8, walls: [...boundaryWalls(w, d), ...extra], items: [] });

/* ---------------- 一、面覆盖守恒（半边走漏一侧就立刻对不上） ---------------- */

test('面覆盖守恒：不管墙怎么画，所有房面之和 == 整栋 w×d', () => {
  resetParams();
  const cases = [
    ['无墙', box([], 8, 6)],
    ['单房（旧文件那一代）', box()],
    ['一刀两间', box([W(4, 0, 4, 6)])],
    ['T 形', box([W(4, 0, 4, 3), W(0, 3, 8, 3)])],
    ['十字', box([W(4, 0, 4, 6), W(0, 3, 8, 3)])],
    ['斜墙', box([W(0, 0, 8, 6)])],
    ['自由端（尖刺）', box([W(4, 0, 4, 3)])],
    ['三间条', box([W(3, 0, 3, 6), W(6, 0, 6, 6)], 9, 6)],
    ['墙戳出整栋', box([W(0, 0, 10, 0)])],
    ['带门洞的隔墙', box([W(4, 0, 4, 6, [{ at: 3, w: 0.9, h: 2.1 }])])],
    ['墙角斜着切一刀', box([W(0, 0, 2, 2)])],
  ];
  for (const [name, layout] of cases) {
    // 变异点：面遍历取错出边（例如取"逆时针最近"而不是"顺时针最近"）→ 面数错、面积丢一块
    assert.ok(Math.abs(roomAreaTotal(layout) - layout.w * layout.d) < 1e-6,
      `${name}：房面之和 ${roomAreaTotal(layout)} ≠ ${layout.w * layout.d}`);
  }
});

test('没有墙也算一间（外框兜底）—— 旧单房间文件导入后恰好 1 间整屋面', () => {
  resetParams();
  const rooms = roomsOf(box());
  assert.equal(rooms.length, 1);
  assert.equal(Math.round(rooms[0].area * 100) / 100, 48);
  assert.deepEqual(wallClasses(box()), ['boundary', 'boundary', 'boundary', 'boundary']);
});

/* ---------------- 二、墙的三值：外墙 / 隔墙 / 房内隔断 ---------------- */

test('墙三值：隔墙两侧是不同的房；房内隔断两侧是同一间；外墙只有一侧有房', () => {
  resetParams();
  const cls = (layout) => wallClasses(layout);
  // 一刀两间 → 前 4 面外墙 + 第 5 面隔墙
  assert.deepEqual(cls(box([W(4, 0, 4, 6)])), ['boundary', 'boundary', 'boundary', 'boundary', 'party']);
  // 自由端内墙：它没把房间切开 → 两侧还是同一间
  // 变异点：把分类写成"内侧一律 party" → 这条立刻红
  assert.deepEqual(cls(box([W(4, 0, 4, 3)])), ['boundary', 'boundary', 'boundary', 'boundary', 'interior']);
});

test('墙双侧归属来自面遍历（不是拿中点猜）：T 形里被 T 到的那面墙两侧各一间', () => {
  resetParams();
  const layout = box([W(4, 0, 4, 3), W(0, 3, 8, 3)]);
  const adj = wallAdjacency(layout);
  const rooms = roomsOf(layout);
  // 横墙（序号 5，(0,3)→(8,3)）两侧：上方两间、下方一整间 —— 至少两个不同的房
  const across = adj[5];
  assert.equal(across.cls, 'party');
  assert.ok(across.rooms.length >= 2, `横墙应邻至少两间，实际 ${across.rooms.length}`);
  // 竖墙（序号 4，(4,0)→(4,3)）两侧各一间
  assert.equal(adj[4].cls, 'party');
  assert.equal(adj[4].rooms.length, 2);
  // 每条非外墙都必须**两侧都有房**（判据：墙不许有一侧落空 —— 落空 = 面遍历漏了一个面）
  for (const a of adj) {
    if (a.cls === 'boundary') continue;
    assert.ok(a.rooms.length >= 1, `墙 ${a.index} 两侧都落空了`);
  }
  assert.equal(rooms.length, 3);
});

test('十字交叉要拆点：一横一竖 = 4 间（漏拆点会算成 1 间，而面积还是对的）', () => {
  resetParams();
  const rooms = roomsOf(box([W(4, 0, 4, 6), W(0, 3, 8, 3)]));
  assert.equal(rooms.length, 4);
  for (const r of rooms) assert.ok(Math.abs(r.area - 12) < 1e-6, `每间应为 12，实际 ${r.area}`);
});

test('越界墙：派生面仍然恰好铺满（墙戳出去的那截只形成外侧的尖刺）', () => {
  resetParams();
  const layout = box([W(0, 0, 10, 0)]);
  assert.ok(Math.abs(roomAreaTotal(layout) - 48) < 1e-6);
  assert.equal(roomsOf(layout).length, 1);
});

/* ---------------- 三、房间 id 不漂移 ---------------- */

test('房间 id 是顶点集合的散列：插一面墙，别的房间 id 不变', () => {
  resetParams();
  const a = roomsOf(box([W(3, 0, 3, 6)], 9, 6));
  const b = roomsOf(box([W(3, 0, 3, 6), W(6, 0, 6, 6)], 9, 6));
  assert.equal(a[0].id, b[0].id, '左间的 id 不该因为右边多了一面墙而改变');
  // 变异点：id 用"出现顺序"（`rooms.length` 或遍历序号）→ 这条立刻红
  assert.equal(a.length, 2);
  assert.equal(b.length, 3);
});

test('id 与"从哪个顶点开始走、往哪个方向绕"无关（同一个面换了起点还是同一个 id）', () => {
  resetParams();
  const poly = [[0, 0], [4, 0], [4, 3], [0, 3]];
  const rotated = [[4, 0], [4, 3], [0, 3], [0, 0]];
  const reversed = [...poly].reverse();
  assert.equal(ringId(poly), ringId(rotated));
  assert.equal(ringId(poly), ringId(reversed));
});

/* ---------------- 四、单一真源：派生量不许混进 state ---------------- */

test('导出里永不出现 `rooms`；`roomLabels` 只在真有名字时出现', () => {
  resetParams();
  const layout = box([W(4, 0, 4, 6)]);
  const txt = exportScheme(layout);
  // 变异点：把 roomsOf() 的结果写进 exportScheme → 这条立刻红（派生量一旦进真源，
  // 就会和墙漂开，而且库/分享/交付全要跟着迁移）
  assert.ok(!txt.includes('"rooms"'), '导出里不许有 rooms 字段');
  assert.ok(!txt.includes('roomLabels'), '没命名时不该写这个字段（旧文件与新文件才能长得一样）');

  const rooms = roomsOf(layout);
  const named = { ...layout, roomLabels: { [rooms[0].id]: '冰箱间' } };
  const txt2 = exportScheme(named);
  assert.ok(txt2.includes('roomLabels'));
  const back = importScheme(txt2);
  assert.equal(back.ok, true, back.message);
  assert.deepEqual(back.layout.roomLabels, { [rooms[0].id]: '冰箱间' });
  assert.equal(exportScheme(back.layout), txt2, '带房间名也要同代逐字节往返稳定');
});

test('房间名走"宽容读、不截断"：昨天的长名字不会被今天的上限切掉', () => {
  resetParams();
  const long = '这是一个非常非常长的房间名字超过了参数上限';
  const label = readRoomLabel(long);
  assert.equal(label, long, '读文件不截断');
  assert.equal(readRoomLabel('  冰箱　间  ').includes('\u3000'), false, '全角空白也要收干净');
  assert.equal(cleanRoomName(long).length, cfg.room.nameMaxChars, '界面输入才截断');
  assert.deepEqual(cleanRoomLabels({ a: 1, b: null, c: '冰箱间' }), { c: '冰箱间' }, '非字符串一律当没写');
});

test('陈旧名字（界面说「在等房间」的那个）在导出里不许被静默丢掉', () => {
  resetParams();
  const layout = box([W(4, 0, 4, 6)]);
  const roomId = roomsOf(layout)[0].id;
  const stale = 'zzzzzzz';   // 不是任何房间的 id：墙改过之后残留的那个名字
  const named = { ...layout, roomLabels: { [roomId]: '冷藏间', [stale]: '等在等' } };
  const txt = exportScheme(named);
  // 变异点：把 cleanRoomLabels 改回按 rooms 过滤 → 这条立刻红。
  // 为什么不许过滤：① 名字跟着几何 id 走，墙改回去名字就回来（撤销能恢复名字的全部依据）；
  // ② Java 侧没有面遍历，规则一旦依赖房间，两边导出的字节就会分叉。
  assert.ok(txt.includes(stale), '暂时对不上的名字也要跟着文件走');
  const back = importScheme(txt);
  assert.equal(back.ok, true, back.message);
  assert.deepEqual(Object.keys(back.layout.roomLabels).sort(), [roomId, stale].sort());
  assert.equal(exportScheme(back.layout), txt, '带残留名字也要同代逐字节往返稳定');
});

/* ---------------- 五、roomAt：墙上不硬塞 ---------------- */

test('roomAt：房内给房；落在墙厚里 / 整栋外给 null（不猜一间硬塞）', () => {
  resetParams();
  const layout = box([W(4, 0, 4, 6)]);
  const left = roomsOf(layout)[0];
  assert.equal(roomAt(layout, 1, 1).id, left.id);
  assert.equal(roomAt(layout, 4, 3), null, '点在隔墙上 → 不挑一间');
  assert.equal(roomAt(layout, 9, 3), null, '点在整栋外 → 没有房间');
});

/* ---------------- 六、隔墙仍是障碍（成对：还会挡 / 门洞能过） ---------------- */

test('隔墙和从前的内墙一样是障碍物：设备摆在隔墙上 = 碰墙', () => {
  resetParams();
  const layout = box([W(4, 0, 4, 6)]);
  const item = { id: 1, p: 'demo-cabinet-800', x: 4, z: 3, r: 0 };
  // 变异点：把隔墙也当成"外墙"跳过碰撞（多房间下最容易犯的错）→ checkItem 会返回 OK，这条红
  assert.equal(checkItem({ ...layout, items: [] }, item, getProduct), REASON.HIT_WALL);
});

test('跨房门洞连通（成对）：隔墙上有门洞 → 人能走过去；把门洞删掉 → 同一条路线被挡住', () => {
  resetParams();
  const plain = box([W(4, 0, 4, 6)]);
  assert.equal(blocked(4, 3, plain, getProduct), true, '实心隔墙挡住');

  const r = placeOpening(plain, 4, { at: 3, w: 0.9, h: 2.1 });
  assert.equal(r.ok, true, r.message);
  // 变异点：碰撞改回"整墙一律挡"（不过 solidSegments）→ 这条红；
  //        改成"整墙一律不挡"→ 上面那条 plain 的断言红。两条都在场才锁得住。
  assert.equal(blocked(4, 3, r.layout, getProduct), false, '门洞处应当能走过去');
  assert.equal(blocked(4, 1.2, r.layout, getProduct), true, '门洞旁边的墙身照样挡');
});

/* ---------------- 七、窄缝：只标不藏 ---------------- */

test('两面墙贴太近会挤出一条窄缝：列表里**标出来**，不许悄悄抹掉', () => {
  resetParams();
  const layout = box([W(0.05, 0, 0.05, 6)]);          // 距外墙 5 cm → 0.3 ㎡ 的缝（阈值 0.5）
  const rooms = roomsOf(layout);
  assert.equal(rooms.length, 2);
  const sliver = rooms.find((r) => r.sliver);
  assert.ok(sliver, '窄缝要被标出来');
  assert.ok(sliver.area < cfg.room.minAreaM2);
  assert.equal(Math.round(sliver.area * 100) / 100, 0.3);
  // 变异点：把窄缝从列表里过滤掉 → 面积之和不再等于 w×d（同时这条红）
  assert.ok(Math.abs(roomAreaTotal(layout) - 48) < 1e-6);
  // 阈值调到 0 → 什么都不算窄缝（参数读的是当次配置，不是模块加载时的值）
  configure({ room: { minAreaM2: 0 } });
  assert.equal(roomsOf(layout).some((r) => r.sliver), false);
  resetParams();
});

/* ---------------- 八、房间名：搬家规则 ---------------- */

test('改名搬家：两间并成一间 → 面积大那间的名字活下来，被并掉的**报出来**（不静默选一个）', () => {
  resetParams();
  const two = box([W(4, 0, 4, 6)]);
  const rooms = roomsOf(two);
  const labels = { [rooms[0].id]: '冰箱间', [rooms[1].id]: '离心机房' };
  // 把两间面积做成不等（隔墙偏左：左间 18 ㎡、右间 30 ㎡）—— 名字按面积挂对，别挂反
  const two2 = box([W(3, 0, 3, 6)]);
  const r2 = roomsOf(two2);
  const big = r2.find((r) => r.area > 20);
  const small = r2.find((r) => r.area < 20);
  assert.ok(big && small, '该有一大一小两间');
  const l2 = { [big.id]: '大间', [small.id]: '小间' };
  const merged = roomsOf(box());
  const out = carryLabels(r2, l2, merged);
  assert.deepEqual(Object.values(out.labels), ['大间'], '面积大的名字活下来');
  assert.deepEqual(out.dropped, [{ name: '小间', reason: 'merged', into: '大间' }], '被并掉的要报出来');

  // 一刀两间仍然两间：名字各自跟着走，一个都不掉
  const after = carryLabels(rooms, labels, rooms);
  assert.deepEqual(after.labels, labels);
  assert.equal(after.dropped.length, 0);
  assert.equal(after.unnamed, 0);
});

test('改名搬家：切一刀 → 老名字跟着老地方，新的一间如实算"未命名"', () => {
  resetParams();
  const before = roomsOf(box([W(4, 0, 4, 6)]));
  const labels = { [before[0].id]: '冰箱间' };
  const after = roomsOf(box([W(4, 0, 4, 6), W(0, 3, 8, 3)]));
  const out = carryLabels(before, labels, after);
  assert.deepEqual(Object.values(out.labels), ['冰箱间']);
  assert.equal(out.unnamed, after.length - 1);
});

test('撤销能带回房间名：形状变回去 → id 变回去 → 名字自己回来', () => {
  resetParams();
  const plain = box();
  const base = roomsOf(plain);
  const labels = { [base[0].id]: '冰箱间' };
  const split = roomsOf(box([W(4, 0, 4, 6)]));
  const gone = carryLabels(base, labels, split);
  // 砍掉隔墙（= 用户删掉隔墙 / 撤销）→ 房间 id 回到原来的那一间 → 名字还在 state 里，直接挂回来
  const back = roomsOf(plain);
  assert.equal(gone.labels[back[0].id], undefined, '切分后名字挂在子间上（形状变了）');
  assert.equal(labels[back[0].id], '冰箱间', 'state 里的名字没丢 —— 形状回来就用得上');
});

/* ---------------- 九、两个新手势：画房间 / 切分 ---------------- */

test('画房间：已存在的边不再画一遍（共享墙永远只有一条记录）', () => {
  resetParams();
  const layout = box();
  const rect = roomOutlineWalls(layout, { x0: 4, z0: 0, x1: 8, z1: 6 });
  assert.equal(rect.walls.length, 1, '贴边的三条边该复用，只有中间那道是新墙');
  assert.equal(rect.reused.length, 3);
  assert.equal(rect.total, layout.walls.length + 1);
  // 把新墙加进去 → 真的变成两间
  const after = { ...layout, walls: [...layout.walls, ...rect.walls] };
  assert.equal(roomsOf(after).length, 2);
  // 变异点：不复用（四条边全画）→ 共享墙会有两条记录，判据"墙池只改 1 条"就守不住了
  const room2 = roomOutlineWalls(after, { x0: 0, z0: 0, x1: 4, z1: 6 });
  assert.equal(room2.walls.length, 0, '第二间房的所有边都已经存在');
  assert.equal(room2.total, after.walls.length);
});

test('画房间：跟已有墙**部分**重叠时不动它，但如实报出来', () => {
  resetParams();
  const layout = box([W(0, 0, 2, 0)]);     // 只覆盖左半段的下边
  const rect = roomOutlineWalls(layout, { x0: 0, z0: 0, x1: 8, z1: 6 });
  assert.deepEqual(rect.overlaps, [4], '半截墙要报出来（不静默改用户画过的东西）');
});

test('切分房间：两端自动接到墙上；接不上/不在房里如实拒绝（不假装做成了）', () => {
  resetParams();
  const layout = box();
  const ok = planSplit(layout, { a: [3, 3], b: [5, 3] });
  assert.equal(ok.ok, true, ok.message);
  assert.equal(ok.roomsBefore, 1);
  assert.equal(ok.roomsAfter, 2);
  assert.equal(Math.round(ok.extendedA * 100) / 100, 3, '左端自动接到 x=0');
  assert.equal(Math.round(ok.extendedB * 100) / 100, 3, '右端自动接到 x=8');
  assert.deepEqual(ok.wall.a, [0, 3]);

  const outside = planSplit(layout, { a: [9, 9], b: [9.5, 9] });
  assert.equal(outside.ok, false);
  assert.equal(outside.reason, 'not-in-room');

  // 贴着墙画（落在墙厚里）→ 单独一个原因码，提示"往房间中间拖"（说"不在任何房间"会把人搞糊涂）
  const miss = planSplit(layout, { a: [2, 0.02], b: [3, 0.02] });
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'on-wall');
  assert.ok(miss.message.includes('压在墙上'));

  // 没有墙的布局也能切：外框同样是"墙"（房间就是外框 + 内墙剖出来的）
  const bare = { w: 8, d: 6, h: 2.8, walls: [], items: [] };
  const ok2 = planSplit(bare, { a: [3, 3], b: [5, 3] });
  assert.equal(ok2.ok, true, ok2.message);
  assert.deepEqual(ok2.wall.a, [0, 3]);
  assert.deepEqual(ok2.wall.b, [8, 3]);
});

test('切分房间：墙数到上限时如实拒绝（不画一条进不去的墙）', () => {
  resetParams();
  const layout = box();
  configure({ layout: { maxWalls: layout.walls.length } });
  const r = planSplit(layout, { a: [3, 3], b: [5, 3] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-many-walls');
  resetParams();
});

/* ---------------- 十、跨房墙编辑一致（硬要求④） ---------------- */

test('改隔墙一个端点：两间的边界同变，墙池**只改 1 条**（没有"两份墙"可漂）', () => {
  resetParams();
  const layout = box([W(4, 0, 4, 6)]);
  const before = roomsOf(layout);
  const moved = { ...layout, walls: layout.walls.map((w, i) => (i === 4 ? W(3, 0, 4, 6) : w)) };
  const after = roomsOf(moved);
  assert.equal(moved.walls.length, layout.walls.length, '墙还是那么几条');
  assert.equal(after.length, 2);
  assert.notEqual(after[0].id, before[0].id, '左边那间的形状变了');
  assert.notEqual(after[1].id, before[1].id, '右边那间也跟着变（共享的那条墙）');
  // 变异点：每间存一份墙 → 这里改一条就只动一间，另一间纹丝不动 → 红
  assert.equal(after[0].area + after[1].area, 48);
});

/* ---------------- 十一、缩略图与摘要 ---------------- */

test('缩略图：点全部落在画框里（界面不自己算几何）', () => {
  resetParams();
  const room = roomsOf(box([W(4, 0, 4, 6)]))[0];
  const t = roomThumb(box([W(4, 0, 4, 6)]), room, 96);
  assert.equal(t.size, 96);
  for (const [x, z] of t.points) {
    assert.ok(x >= -0.001 && x <= 96.001, `点在框外：x=${x}`);
    assert.ok(z >= -0.001 && z <= 96.001, `点在框外：z=${z}`);
  }
});

test('房间摘要：没名字的显示「未命名房间」（不是编号，用户拍板）', () => {
  resetParams();
  const layout = box([W(4, 0, 4, 6)]);
  const rooms = roomsOf(layout);
  const list = roomSummary(layout, { [rooms[0].id]: '冰箱间' });
  assert.equal(list[0].displayName, '冰箱间');
  assert.equal(list[1].displayName, DEFAULT_ROOM_NAME);
  assert.equal(list[1].name, '');
  assert.equal(list[0].walls.length, 4);
});

/* ---------------- 十二、规模与容差 ---------------- */

test('容差是毫米级：差 1 mm 的端点归成同一个顶点（不然面在那点断开，少一块）', () => {
  resetParams();
  assert.ok(JOIN_TOL_M <= 0.001);
  const a = box([W(4, 0, 4, 6)]);
  const b = box([W(4, 0, 3.9995, 6)]);        // 差 0.5 mm
  assert.equal(roomsOf(b).length, 2, '毫米级偏差不该把面切开');
  assert.ok(Math.abs(roomAreaTotal(b) - 48) < 1e-6);
});

test('100 面墙也扛得住：不抛错、面积仍然守恒', () => {
  resetParams();
  const walls = [];
  for (let i = 1; i <= 20; i++) walls.push(W(i * 0.4, 0, i * 0.4, 6));      // 20 竖
  for (let i = 1; i <= 20; i++) walls.push(W(0, i * 0.28, 8, i * 0.28));     // 20 横
  const layout = { w: 8, d: 6, h: 2.8, walls, items: [] };
  const rooms = roomsOf(layout);
  assert.ok(rooms.length > 100, `该剖出很多间，实际 ${rooms.length}`);
  assert.ok(Math.abs(roomAreaTotal(layout) - 48) < 1e-6);
  assert.ok(rooms.every((r) => Number.isFinite(r.area) && r.area > 0));
});

test('缓存不吃配置：改了窄缝阈值，读数要跟着变（缓存键里得带上参数）', () => {
  resetParams();
  const layout = box([W(0.05, 0, 0.05, 6)]);          // 0.3 ㎡
  assert.equal(roomsOf(layout).some((r) => r.sliver), true);
  configure({ room: { minAreaM2: 0.1 } });            // 0.1 < 0.3 → 不再算窄缝
  assert.equal(roomsOf(layout).some((r) => r.sliver), false);
  resetParams();
  assert.equal(roomsOf(layout).some((r) => r.sliver), true);
});

test('合法外墙不许误报：贴在整栋四边上的墙全部合法（多房间下这条更要紧）', () => {
  resetParams();
  const layout = box([W(4, 0, 4, 6)]);
  assert.deepEqual(checkAllWalls(layout), [], '四条外墙 + 一条隔墙都不该报越界');
  const out = box([W(0, 0, 9, 0)]);
  assert.deepEqual(checkAllWalls(out), [{ index: 4, reason: WALL_REASON.WALL_OUT_OF_ROOM }], '戳出去的要报');
});

test('createLayout 不带房间名（默认就没有这个字段）', () => {
  resetParams();
  assert.equal(createLayout().roomLabels, undefined);
});