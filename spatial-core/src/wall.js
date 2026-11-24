/**
 * wall.js —— 墙的记录形状（**唯一一份**）
 *
 * ## 为什么有它（W1 门洞，设计决策记录）
 *
 * 墙原来是一个扁平数组 `[x1, z1, x2, z2]`。门洞要挂在墙上、还要在"改房间尺寸 / 删墙"
 * 引起的墙列表重排之后**仍然指着原来那面墙** —— 用下标指墙会静默错指，所以门洞必须是
 * 墙自己的字段：墙升级成对象
 *
 *     { a: [x, z], b: [x, z], openings: [{ at, w, h }] }              ← 门（kind 缺省）
 *     { a: [x, z], b: [x, z], openings: [{ at, w, h, kind, sill }] }  ← 窗（W2）
 *
 * `a`/`b` 是**端点**（世界绝对坐标，米）。`at` 是洞口中心**沿墙自 `a` 起**的弧长（米），
 * 不是 0..1 的比例 —— 比例会在墙变长时把洞悄悄挪位置（静默改数）。
 *
 * ## 开放场景（P1，设计决策记录/93）：多一个可选 `role`
 *
 *     { a, b, openings?, role?: 'exterior' | 'interior' }
 *
 * `role` 是墙的**持久化语义**（外墙 / 内墙），不是「贴不贴边」的几何别名：
 * 旧文件没有它就是**按几何回退**（见 `room.wallRole`），不是「内墙」。
 * 字段顺序固定为 `a, b, openings?, role?`，**有值才写** —— 旧墙导出字节不变、新墙同代稳定。
 * 非法 `role` 值在读取端**当没写**（F4：导入宽容，不因此拒绝整份文件；几何回退接手）。
 *
 * ## 洞口的记录形状也只有这一份（W2 窗，设计决策记录）
 *
 * ⚠️ 加窗之前，`{ at, w, h }` 这个形状在代码里是**手抄的**，一共 6 处窄门
 * （`mkWall`、`readWall`、`openings.withOpenings`、`room` 重建外墙、Java `Scheme` 的读写）
 * —— 每一处都「只认识 3 个字段」，新加进来的字段会在这些地方**无警告消失**，
 * 而且消失得很晚（保存→读回→分享→交付某一环）、很难查。
 * 其中最难发现的一处是 `room.js` 重建外墙：**改一次房间尺寸，窗就降级成落地洞**。
 *
 * 所以洞口的造 / 读 / 拷也收进这里（`mkOpening` / `readOpening` / `cloneOpening`），
 * 与端点那两条读法同一个理由：**形状一改，任何一处还手抄 `{at,w,h}` 都会立刻露馅**。
 *
 * 写法冻结（零回归的关键）：**`kind` 只在窗上写，门省略它**（同 `openings` 字段本身
 * 「空就不写」的先例）—— 于是今天所有含门洞的方案导出**逐字节不变**（设计决策记录 §2.2）。
 * 字段顺序 `at` / `w` / `h` / `kind` / `sill` 与 Java `Scheme.wallJson()` **必须一致**
 * （顺序也是逐字节比对的一部分）。
 *
 * ## 这个模块存在的另一个目的：让"按数组读墙"这件事不可能悄悄发生
 *
 * 全仓有 7 个地方要读墙的端点和 1 处读 `walls[i]` 的坐标。形状一改，任何一处还写 `w[0]`
 * 都会得到 `undefined` → 长度算成 `NaN` → 墙被当零长跳过 → **渲染里静默少一截**。
 * 所以端点的读法只有这两条：
 *
 *   - `wallSeg(w)` → `[x, z, xx, zz]`（要老式四个数的算法直接解构用，改动面最小）
 *   - `wallA(w)` / `wallB(w)` → `[x, z]`
 *
 * 导入端的**宽容归一化**也在这里（`readWall` / `readOpening`）：老文件的数组形状要能读进来，
 * 但**写出去只有一种形状**（"读取端宽容、写入端唯一"，与 设计决策记录的格式改名前例一致）。
 * 归一化放在边界上做一次，下游就永远只面对一种形状。
 */

/** 端点（世界坐标，米）。返回值是**墙自己数组的引用**，调用方不要改它（改布局要整份新建） */
export function wallA(w) {
  return w.a;
}

/** 见 {@link wallA} */
export function wallB(w) {
  return w.b;
}

/**
 * 老式四数读法 `[x, z, xx, zz]`。
 * 给"拿四个数去算距离/角度/多边形"的地方用（它们原来就是解构数组写的，换成这个改动最小）。
 */
export function wallSeg(w) {
  return [w.a[0], w.a[1], w.b[0], w.b[1]];
}

/** 墙长（米） */
export function wallLen(w) {
  return Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
}

/** 洞口清单：**恒为数组**（没有洞口的墙就不写这个字段，读的时候不用到处判 undefined） */
export function openingsOf(w) {
  return Array.isArray(w.openings) ? w.openings : [];
}

/* ---------------- 墙的角色（P1 开放场景）：**唯一一份** ---------------- */

/** 外墙（场景外缘的墙；v1 不挡设备，见 validate.checkItem） */
export const EXTERIOR = 'exterior';
/** 内墙（场景内部隔断；参与设备碰撞） */
export const INTERIOR = 'interior';

/**
 * `role` 是不是合法值。
 * 非法值（如 `'wall'`、数字、大小写不对）一律**当没写** —— 这是导入端的宽容口径（F4），
 * 不是"再猜一个就近值"：认不得就回几何回退，由 `room.wallRole` 一处决定。
 */
export function isWallRole(v) {
  return v === EXTERIOR || v === INTERIOR;
}

/** 读墙的**显式**角色：合法就原样返回，缺省/非法 → null（不代表内墙！几何回退在 room.wallRole） */
export function roleOf(w) {
  return isWallRole(w?.role) ? w.role : null;
}

/* ---------------- 洞口的记录形状：**唯一一份**（W2 窗） ---------------- */

/** 窗的 `kind` 字面量（门**不写** `kind` —— 缺省即门，见模块头「写法冻结」） */
export const WINDOW = 'window';

/**
 * 洞口的类别：`'door'`（**缺省**）或 `'window'`。
 *
 * 认不得的 `kind` 一律当门 —— 与 `wallstyle.js normalizeWallStyle()` 同一条规矩
 * （「认不得的档位两侧都当没写」）：不报错、不猜、不回就近值。
 * 未来真出现第三种洞口，格式标识会再换代（设计决策记录 §2.4），不会以「同在那一代里」的身份出现。
 */
export function kindOf(o) {
  return o?.kind === WINDOW ? WINDOW : 'door';
}

/** 是不是窗 */
export function isWindowOpening(o) {
  return kindOf(o) === WINDOW;
}

/** 洞口类别的人话名（内核出话、界面原样转述 —— 文案只有一份） */
export function holeName(kind) {
  return kind === WINDOW ? '窗' : '门洞';
}

/**
 * 洞口底边**离地高度**（米）：**门恒 0**；窗取 `sill`。
 *
 * 语义冻结：从**地面**量到**洞口下沿**（不是中心、不是上沿）。
 * 非有限数 / 负数退回 0 —— 那是结构校验该拦的事（`openings.checkOpeningShape`），
 * 几何层只保证自己不吃 NaN（NaN 会被 `mergeGeometries` 吞进去，现场表现为「墙没了」）。
 */
export function sillOf(o) {
  if (kindOf(o) !== WINDOW) return 0;
  const v = Number(o?.sill);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 造一个洞口（**写入端唯一**）。
 *
 * 值**原样搬运**、不做 `Number()` 归一化 —— 这是刻意的：老的 `mkWall` 就是原样搬，
 * 而归一化会让「字段是 `undefined`」变成「字段是 `NaN`」，偏偏 `JSON.stringify`
 * 对 `undefined` 是**删字段**、对 `NaN` 是写 `null` —— 同代往返的逐字节比对会因此变化。
 */
export function mkOpening(o) {
  const out = { at: o?.at, w: o?.w, h: o?.h };
  if (kindOf(o) === WINDOW) {
    out.kind = WINDOW;
    out.sill = o?.sill;
  }
  return out;
}

/**
 * 宽容读一个洞口（**读取端宽容**）：老文件（没有 `kind`）读进来就是门；
 * 数字一律 `Number()` 归一化（与老的 `readWall` 逐字同行为）。
 * `sill` 只有在真的是窗时才读 —— 门身上挂着一个多余的 `sill` 当没写（写入端就会把它擦掉）。
 */
export function readOpening(v) {
  const out = { at: Number(v?.at), w: Number(v?.w), h: Number(v?.h) };
  if (v?.kind === WINDOW) {
    out.kind = WINDOW;
    out.sill = Number(v?.sill);
  }
  return out;
}

/** 深拷贝一个洞口（改房间尺寸 / 撤销快照时用） */
export function cloneOpening(o) {
  return mkOpening(o);
}

/** 造一面墙（`openings` 为空时**不写**这个字段：方案文件里不出现 `"openings": []` 这些噪音） */
export function mkWall(a, b, openings = [], role = null) {
  const w = { a: [a[0], a[1]], b: [b[0], b[1]] };
  if (openings.length) w.openings = openings.map(mkOpening);
  // 字段顺序固定 a,b,openings?,role?；role 非法/缺省一律不写（旧墙字节不变，F4 宽容）
  if (isWallRole(role)) w.role = role;
  return w;
}

/** 由四个数造墙（`addWall` / 用例夹具这类"手里只有坐标"的地方用） */
export function mkWallSeg(x, z, xx, zz, openings = [], role = null) {
  return mkWall([x, z], [xx, zz], openings, role);
}

/** 是不是墙对象（形状层面；坐标合法性由调用方按自己的口径查） */
export function isWallShape(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && Array.isArray(v.a) && v.a.length === 2
    && Array.isArray(v.b) && v.b.length === 2;
}

/** 是不是老式数组墙 */
export function isLegacyWallArray(v) {
  return Array.isArray(v) && v.length === 4;
}

/**
 * 宽容读一面墙 —— 只做**形状**归一化，不做任何业务校验（长度、越界、洞口范围都由调用方查）。
 *
 * 角色口径（F4）：合法 `role` 原样保留；非法 `role`（如 `'wall'`）**当没写**、不返回错误 ——
 * 拒绝整份文件会让旧/脏文件打不开，几何回退才是这里的兜底。
 * @returns {{a:[number,number], b:[number,number], openings:Array, role?:string}|null} 形状不认识就 null
 */
export function readWall(v) {
  if (isLegacyWallArray(v)) {
    const nums = v.every((n) => typeof n === 'number' && Number.isFinite(n));
    return nums ? { a: [v[0], v[1]], b: [v[2], v[3]] } : null;
  }
  if (isWallShape(v) && [...v.a, ...v.b].every((n) => typeof n === 'number' && Number.isFinite(n))) {
    const w = { a: [v.a[0], v.a[1]], b: [v.b[0], v.b[1]] };
    if (Array.isArray(v.openings) && v.openings.length) {
      w.openings = v.openings.map(readOpening);
    }
    if (isWallRole(v.role)) w.role = v.role;
    return w;
  }
  return null;
}

/** 深拷贝一面墙（撤销快照 / 改房间尺寸时用；避免新旧布局共享同一批数组） */
export function cloneWall(w) {
  return mkWall(w.a, w.b, openingsOf(w), roleOf(w));
}