/**
 * doors.measured.js —— 门的**实测**几何（自动生成，勿手改）
 *
 * 生成：node scripts/gen-doors.mjs（由 npm run assets 自动调用）
 * 上游：assets/catalog/models.verified.json ← tools/models/verify-models.py ← assets/models/*.glb
 *
 * 坐标系：**相对设备中心的本地平面坐标**（米）：x = 宽方向，z = 深方向，与内核 corners() 同向。
 *   把本地点换成平面点： [x + lx·cos(r) − lz·sin(r), z + lx·sin(r) + lz·cos(r)]（r = 设备旋转角）。
 *   z 已含加载器的等比缩放；铰链位置是模型里真实的节点原点，不是"前脸左端"的猜测。
 *
 * 为什么单开一个文件：catalog.js 是"产品声明"，这里放的是"从 GLB 里量出来、再换算到平面"的几何。
 * 两个来源混在一起以后就分不清谁是声明的、谁是量出来的。平面图只读这里；三维视图直接用运行时节点。
 * doors=[] 或没这个型号 → 平面图退回"按柜宽估"，那是回退、不是等价的算法。
 */

export const DOORS_MEASURED = {
  "demo-blender": {
    "source": "1:1",
    "fitScale": 1,
    "declaredMm": {
      "w": 676,
      "d": 672
    },
    "doors": [
      {
        "node": "door_single",
        "nodes": [
          "door_single"
        ],
        "axis": "y",
        "openAngleDeg": 106,
        "hinge": {
          "x": -0.26,
          "y": 0.1905,
          "z": 0.285
        },
        "swing": 0.55833,
        "leaf": {
          "x0": -0.26,
          "x1": 0.296,
          "z0": 0.272,
          "z1": 0.336
        },
        "exact": true,
        "sharedAccessor": false,
        "openExtra": 0.42057
      }
    ],
    "trusted": true
  }
};

/** 取某型号已量到的门（没有则空数组 = 调用方回退估算） */
export function measuredDoors(productId) {
  return DOORS_MEASURED[productId]?.doors ?? [];
}

/** 该型号的门几何是否可信（含缩放口径）；false 时调用方应把扇形标成估值 */
export function doorsTrusted(productId) {
  return DOORS_MEASURED[productId]?.trusted === true;
}
