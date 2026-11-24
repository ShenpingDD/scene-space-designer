/**
 * walkbasis.js —— 「前 / 右 → 世界位移」的**唯一出处**（第一人称漫游）。
 *
 * 为什么单独一个模块：这套换算以前写在 `scene3d.js` 的 `walkMove()` 里，**没有任何测试**，
 * 于是"A/D 反了"这种错可以一直活着 —— 数学上它只差一个符号，跑起来不报错，
 * 用户只能凭手感说"感觉反了"，而手感说不清是哪一条轴。
 *
 * 约定（与平面图一致：x 向右、z 向下；yaw = 0 → 面朝 +z）：
 *   · 前向  f = (sin yaw, cos yaw)
 *   · 右手向 r = (−cos yaw, sin yaw) = (−f_z, f_x)
 *
 * 「右手向」不是随手写的：它是 three.js 里那个相机的**局部 +x 轴**在世界里的方向
 * （相机 `rotation.y = π + yaw`，局部 +x 旋转后正好是 `(−cos yaw, sin yaw)`）。
 * 推导过程见 `test/walkbasis.test.js` 里的"与相机基准互证"那几条 ——
 * 这也是为什么它必须是纯函数：能被算出来、能被断言，就不该靠手感。
 */

export const DEG = Math.PI / 180;

/**
 * 某个朝向下，「前」「右」两个单位向量（房间坐标）。
 * @param {number} yawDeg 朝向角（度，0 = 面朝 +z）
 * @returns {{fx:number, fz:number, rx:number, rz:number}}
 */
export function moveBasis(yawDeg) {
  const a = (Number(yawDeg) || 0) * DEG;
  const fx = Math.sin(a);
  const fz = Math.cos(a);
  return { fx, fz, rx: -fz, rz: fx };
}

/**
 * 「前进 fwd、右移 right」换算成世界位移方向（未乘速度/步长）。
 * 只是把两组单位向量按分量加一加 —— 之所以也放进来，是为了让"前/右的合成"
 * 也只有一份实现（各写一份就会出现"单独按对、一起按歪"这种难查的错）。
 *
 * @param {number} yawDeg 朝向角（度）
 * @param {number} fwd    前进量（+ 前 / − 后）
 * @param {number} right  右移量（+ 右 / − 左）
 * @returns {{dx:number, dz:number}}
 */
export function stepVector(yawDeg, fwd, right) {
  const { fx, fz, rx, rz } = moveBasis(yawDeg);
  const f = Number(fwd) || 0;
  const r = Number(right) || 0;
  return { dx: fx * f + rx * r, dz: fz * f + rz * r };
}