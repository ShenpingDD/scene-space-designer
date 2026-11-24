/**
 * prism.js —— 凸多边形 → **竖直棱柱**的三角面（纯函数，不碰 three）
 *
 * 为什么单独放内核，而不是在 `scene3d.js` 里现搓：
 *   墙构件斜接之后不再是矩形（可能是 5 边形），`BoxGeometry` 用不上了；
 *   而"多边形＝棱柱"这件事是**几何**，不是渲染 —— 放在内核里能被断言
 *   （体积、法线方向、缠绕），放在渲染层里就只能"看着像"。
 *
 * 约定：多边形在**平面坐标 (x, z)** 里给出（与 `corner()` / 平面图同一套），
 *      y 是高度方向：底面 y = 0、顶面 y = h。
 *
 * 缠绕不靠"约定"，靠**当场算一遍**：每个三角形先按某个顺序组出来，
 * 算出它的法线，和"想让它朝哪"比一下，反了就交换两个顶点。
 * 这样无论多边形是顺时针还是逆时针给进来的，出来的都是能直接渲染的面。
 */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
};

/** 把三个顶点按"法线朝 want"的顺序推进数组（want 只是方向，长度会被归一化） */
function pushTri(pos, nor, a, b, c, want) {
  let n = cross(sub(b, a), sub(c, a));
  if (dot(n, want) < 0) { const tmp = b; b = c; c = tmp; n = cross(sub(b, a), sub(c, a)); }
  const nn = unit(n);
  for (const p of [a, b, c]) pos.push(p[0], p[1], p[2]);
  for (let i = 0; i < 3; i++) nor.push(nn[0], nn[1], nn[2]);
}

/**
 * @param {Array<[number,number]>} poly 平面多边形（凸，按顺序，至少 3 点）
 * @param {number} h 棱柱高度（米）—— 从 `base` 算起
 * @param {number} [base] 底面高度（米，默认 0）。W1 门洞的**过梁**就是"底面在门洞顶上的棱柱"，
 *   所以这里要能抬高底面；**默认 0 让没有门洞的路径逐字节不变**（零回归）。
 * @returns {{positions:number[], normals:number[], triangles:number}}
 */
export function prismFaces(poly, h, base = 0) {
  const pos = [];
  const nor = [];
  const n = poly.length;
  if (n < 3) return { positions: pos, normals: nor, triangles: 0 };

  const top = (i) => [poly[i][0], base + h, poly[i][1]];
  const bot = (i) => [poly[i][0], base, poly[i][1]];

  // 顶面 / 底面：扇形三角化（凸多边形，扇形一定合法）
  for (let i = 1; i < n - 1; i++) pushTri(pos, nor, top(0), top(i), top(i + 1), [0, 1, 0]);
  for (let i = 1; i < n - 1; i++) pushTri(pos, nor, bot(0), bot(i), bot(i + 1), [0, -1, 0]);

  // 侧面：每条边一个长方形（两个三角形）。外法线用**多边形重心**当场判：法线不能指向心里。
  let gx = 0;
  let gz = 0;
  for (const p of poly) { gx += p[0]; gz += p[1]; }
  gx /= n;
  gz /= n;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    if (Math.hypot(ex, ez) < 1e-12) continue;               // 重合点：这条边没有面
    const mx = (a[0] + b[0]) / 2;
    const mz = (a[1] + b[1]) / 2;
    let want = [ez, 0, -ex];                                // 候选外法线（平面内 90°）
    // 指向重心 = 指向心里 = 反了
    if (want[0] * (gx - mx) + want[2] * (gz - mz) > 0) want = [-want[0], 0, -want[2]];
    pushTri(pos, nor, [a[0], base, a[1]], [b[0], base, b[1]], [b[0], base + h, b[1]], want);
    pushTri(pos, nor, [a[0], base, a[1]], [b[0], base + h, b[1]], [a[0], base + h, a[1]], want);
  }
  return { positions: pos, normals: nor, triangles: pos.length / 9 };
}