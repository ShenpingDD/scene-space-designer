/**
 * views3d.js —— 交付包里那三张**固定视角**三维截图（A13）
 *
 * 用户拍板 A13（原话）：「① 画布中央正顶部俯视 ② 画布中轴正面斜 45° 半空中正视
 * ③ 画布斜角 45° 半空中斜 45°」，并附了一句「描述的可能不那么专业，你做开发之前再跟我确认下」。
 * → 所以这里把他的话**逐条译成方位角/俯仰角**，并把三个数写在旁边；用户拿三张真图核对（比读参数直观）。
 *
 * ⚠️ **顺序即身份**：交付包里三张图按这个数组的顺序命名（`Delivery.VIEWS` 在服务端）。
 *    改这里的顺序 = 改包里的编号 —— 服务端那份注释里写着同一句话（两处都要看）。
 *
 * 与 `scene2d`/`scene3d` 的关系：这个文件只算**机位**（纯函数，房间尺寸 → 相机位置与朝向）。
 * 真正截图的是 `scene3d.snapshot()` —— 它是浏览器那一侧的事，在这里不掺和。
 */

/**
 * 三个固定视角。`azimuthDeg` 是水平方位角（0° = 从 +z 那一侧正对着看，45° = 从 +x/+z 的斜角），
 * `elevationDeg` 是俯仰角（0° = 平视、90° = 正上方往下看），`distFactor` 是"离多远"。
 *
 * 俯视用 **89.9°** 而不是 90°：正上方的视线与默认的"上方向"（+y）重合时朝向是**不确定的**
 * （相机会自己挑一个滚转角，不同浏览器可能挑得不一样）。差 0.1° 看不出区别，但把它变成一个确定值。
 *
 * `distFactor` 是**观感参数**（留给画幅边缘的余量），不是几何参数：
 * 以 55° 视场角算，刚好装满大约需要 0.96 × 最大边长，所以这三个数都是"再退一点"。
 */
export const SHOT_VIEWS = [
  { id: 'top', label: '正上方俯视', azimuthDeg: 0, elevationDeg: 89.9, distFactor: 1.15 },
  { id: 'front45', label: '正面斜 45°', azimuthDeg: 0, elevationDeg: 45, distFactor: 1.3 },
  { id: 'corner45', label: '斜角 45°', azimuthDeg: 45, elevationDeg: 45, distFactor: 1.4 },
];

export const DEG = Math.PI / 180;

/**
 * 某个视角的机位（**纯函数**：房间尺寸进，相机位置与看向哪出）。
 *
 * 朝向总是房间的**几何中心**（不是"某一个设备"）—— 三张图要能互相对照，
 * 相机换来换去的话，看图的人得先在脑子里把它们对齐，那就白拍了。
 */
export function viewPoint(w, d, h, view) {
  const width = Number(w) || 0;
  const depth = Number(d) || 0;
  const height = Number(h) || 0;
  const target = { x: width / 2, y: height / 2, z: depth / 2 };
  const maxDim = Math.max(width, depth, height, 1);
  const dist = maxDim * view.distFactor;
  const az = view.azimuthDeg * DEG;
  const el = view.elevationDeg * DEG;
  // 水平方向的单位向量：方位角 0° → +z；45° → +x 与 +z 各一半（就是"斜角"）
  const horiz = Math.cos(el) * dist;
  const pos = {
    x: target.x + horiz * Math.sin(az),
    y: target.y + Math.sin(el) * dist,
    z: target.z + horiz * Math.cos(az),
  };
  return { pos, target };
}

/** 第几张（1 起）—— 服务端就是按这个顺序命名的 */
export function shotIndex(view) {
  return SHOT_VIEWS.findIndex((v) => v.id === view.id) + 1;
}

/** 人话描述（界面上"正在截第几张、是什么角度"要用它） */
export function shotHow(view) {
  return `方位角 ${view.azimuthDeg}°、俯仰角 ${view.elevationDeg}°`
    + `（镜头退到最大边长度的 ${view.distFactor} 倍处）`;
}