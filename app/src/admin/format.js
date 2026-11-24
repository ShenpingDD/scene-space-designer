/**
 * format.js —— 系统状态页的**纯格式计算**（R6-1 Step4）
 *
 * 为什么连"显示几个字节"都要抽出来单测：
 *   系统状态页上每个数都是给人做判断用的（磁盘够不够、LOD 齐不齐）。这类"顺手写的格式化"
 *   恰恰最容易出错，而且错了很不起眼 —— 比如把 0 字节显示成 "0.0 KB"（看起来像有东西）、
 *   把 1023 显示成 "1.0 KB"（进位骗人）。它们不会让页面崩，只会让人判断错。
 */

/**
 * 字节 → 人话。**0 就说 0 B**，不显示 "0.0 KB"（那是"有一点"的错觉）。
 *
 * 用 1024 进制（KB/MB），与项目其它地方的写法一致（如"16.71 MB → 1.21 MB"）。
 */
export function formatBytes(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return Math.round(n) + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

/**
 * LOD 覆盖情况。返回的 `ok` 决定界面用什么颜色 —— 所以它必须有判据、必须能测。
 *
 * ⚠️ 这条判据我**改过一次，因为第一版是错的**：
 *   第一版要求"必须看见 3 个文件"，于是把 demo-ct-scanner / demo-freezer-chest 报成「缺层」——
 *   而真相是**优化器故意不出**那一级：压缩到模型自身的三角形下限后，再粗化得到的是
 *   **同一个文件**（demo-ct-scanner: lod2=24270 面 vs lod1=24288 面；demo-freezer-chest: lod1 与 lod0 面数完全相等）。
 *   真缺陷和刻意优化被混成了同一个警报 —— **假角标比没有角标更坏**：
 *   管理员发现一个角标在瞎报，就会开始不信所有角标。
 *
 * 现在的判据：声明的三级各有归宿（出文件 **或** 有"按设计跳过"的记录）才算达标。
 * `byDesign` 单独回出来，是为了界面能**把这件事说出来**（"少出一级"是优化到了下限的证据，
 * 不是毛病）—— 而不是悄悄算过。
 */
export function lodCoverage(lod) {
  const l = lod && typeof lod === 'object' ? lod : {};
  const models = Number(l.models) || 0;
  const full = Number(l.withThreeLevels) || 0;
  const byDesign = Number(l.byDesign) || 0;
  const declaredLevels = Number(l.declaredLevels) || 3;
  const thin = Array.isArray(l.thin) ? l.thin.filter(Boolean) : [];
  return {
    models,
    full,
    byDesign,
    declaredLevels,
    thin,
    ok: models > 0 && full === models && thin.length === 0,
  };
}

/**
 * 迁移版本的说法。
 * **坑**（实测踩过）：按 installed_rank 排最后一条通常是**可重复迁移**（version 为空），
 * 所以"迁移到哪一版"必须从有版本号的里取，否则会显示成"没迁移过"。
 */
export function migrationLabel(system) {
  const s = system && typeof system === 'object' ? system : {};
  const v = s.flywayLastVersioned;
  const rows = Number(s.migrationRows) || 0;
  if (!v) return '未知（没读到有版本号的迁移）';
  return 'V' + v + '（共 ' + rows + ' 条记录，含可重复迁移）';
}
