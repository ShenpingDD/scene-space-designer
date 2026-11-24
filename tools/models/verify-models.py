#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
按 docs/07 的交付规范核对模型资产。纯标准库，不依赖 three.js / gltf-transform。

核对内容：
  1. 文件本身      GLB 头（magic/version/声明长度 vs 实长 = 截断）
  2. 实测包围盒    走节点树累乘 TRS，用 accessor min/max 的 8 个角点变换后合并
  3. 声明包络      与 assets/catalog/products.json 的 w/d/h 逐轴比差（毫米）
  4. 性能预算      docs/07：单模型 ≤60,000 三角面、≤3 MB、贴图有上限
  5. 门（铰链）    门节点自身原点即铰链轴 → 把门子树几何换算到门节点本地坐标，
                   绕轴转 openAngleRad，再贴回世界矩阵 → 得到"开门后"的包围盒
                   → 由此给出**真实扫掠半径**（2D 平面图画扇形用，不再拿柜体宽度估）
                   → 以及**开门方向对不对**（门是往柜外走，还是往柜里扎）

输出 assets/catalog/models.verified.json（供后端建表与前端读），同时打印人读表格。

    python tools/models/verify-models.py
    python tools/models/verify-models.py --json       # 只看 JSON
    python tools/models/verify-models.py --dir <目录>  # 换压缩产物目录（默认 assets/optimized，存在就查）
    python tools/models/verify-models.py --glb <文件.glb> [...]  # 单文件/新增件，不要求在目录里

docs/07 §10（2026-10-23 v3）增量：
  - GLB 文件单位 m；声明/bbox 仍是 mm。历史 mm 文件按源包围盒 >100 单位识别，
    读取时显式 ×0.001，输出 sourceUnit，绝不再把 mm 当 m 造成 ×1000；
  - meta.model_unit（m/mm）若显式给出则优先；
  - meta.anchor_nodes / doors[].node 的锚点必须在当前文件存在；optimized 用源模型
    nodePath 逐级校验 LOD0/1/2，路径变了不算“同名还在”；
  - 同级重名、自动名（Object001 等）、把手/托盘未挂在可动件下 → 报告里提示，不静默。
"""
import json
import math
import re
import struct
import sys
from pathlib import Path

# Windows 控制台默认 GBK，打不出 ✓ / 框线字符，直接切成 UTF-8
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "assets" / "catalog" / "products.json"
OUT = ROOT / "assets" / "catalog" / "models.verified.json"

# 参数表（`tools/export-params.mjs` 从 `spatial-core/src/params.js` 生成，**唯一真源**）。
# 阈值不许在本文件里另写一份 —— 第 3 轮审查 C-10：原来 1:1 的对账容差在这里写死 1.0、
# 而设计端 `app/src/scene3d.js` 写死 5.0，同一个模型在两处得到相反结论。
PARAMS_JSON = ROOT / "config" / "params.default.json"


def param(path, fallback):
    """读参数表的出厂值。读不到就退回 fallback —— 缺一项不许把整个核对判死。"""
    try:
        cur = json.loads(PARAMS_JSON.read_text(encoding="utf-8"))["defaults"]
        for part in path.split("."):
            cur = cur[part]
        return cur
    except Exception:
        return fallback

# docs/07 的性能硬指标
# ⚠️ **线上目录模型的判据只有这一处**（本文件）。`tools/verify/verify-glb.py` 对的是**归档原型**
#    那份 GLB（声称值 ~215k / 1152×1095×1987），是一次性对账工具，**两者不要合并**（输入不同对象）。
LIMIT_TRIANGLES = 60000
LIMIT_BYTES = 3 * 1024 * 1024
LIMIT_TEXTURES = 2

JSON_CHUNK = 0x4E4F534A


# ---------------------------------------------------------------- 矩阵
IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def mul(a, b):
    """列主序 4x4（与 glTF 一致）：mul(a, b) 表示先 b 后 a"""
    out = [0.0] * 16
    for c in range(4):
        for r in range(4):
            out[c * 4 + r] = sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4))
    return out


def apply(m, p):
    x, y, z = p
    return (
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
    )


def trs(t, r, s):
    """TRS(四元数) → 4x4 列主序"""
    x, y, z, w = r
    x2, y2, z2 = x + x, y + y, z + z
    xx, xy, xz = x * x2, x * y2, x * z2
    yy, yz, zz = y * y2, y * z2, z * z2
    wx, wy, wz = w * x2, w * y2, w * z2
    m = [
        (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
        (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
        (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
        t[0], t[1], t[2], 1,
    ]
    return m


def node_local(node):
    if "matrix" in node:
        return list(node["matrix"])
    return trs(node.get("translation", [0, 0, 0]), node.get("rotation", [0, 0, 0, 1]), node.get("scale", [1, 1, 1]))


def replace_rotation(node, axis, angle):
    """模拟 three.js 的 `node.rotation[axis] = angle`：保留 T / S，旋转被整体替换"""
    t = node.get("translation", [0, 0, 0])
    s = node.get("scale", [1, 1, 1])
    if "matrix" in node:  # 少见但可能出现：从矩阵里取平移与缩放
        m = node["matrix"]
        t = [m[12], m[13], m[14]]
        s = [math.hypot(m[0], m[1], m[2]), math.hypot(m[4], m[5], m[6]), math.hypot(m[8], m[9], m[10])]
    half = angle / 2.0
    q = [0, 0, 0, math.cos(half)]
    q["xyz".index(axis)] = math.sin(half)
    return trs(t, q, s)


# ---------------------------------------------------------------- GLB
def parse_glb(path):
    buf = path.read_bytes()
    magic, version, declared = struct.unpack_from("<4sII", buf, 0)
    if magic != b"glTF":
        raise ValueError("不是 GLB 文件（magic=%r）" % magic)
    off, js, bin_bytes, bin_len = 12, None, b"", 0
    while off + 8 <= len(buf):
        clen, ctype = struct.unpack_from("<II", buf, off)
        if ctype == JSON_CHUNK:
            js = json.loads(buf[off + 8:off + 8 + clen].decode("utf-8"))
        else:
            bin_len = clen
            bin_bytes = buf[off + 8:off + 8 + clen]
        off += 8 + clen
    return {"js": js, "bytes": len(buf), "version": version, "declared": declared,
            "truncated": declared != len(buf), "bin": bin_len, "bin_bytes": bin_bytes}


def dequant(c, component_type, normalized):
    """
    量化后的 accessor 读值必须走反量化。

    踩过的坑：quantize 把 POSITION 存成 int16 `normalized: true`，accessor 的 min/max 是
    原始整数（例：[-17434, -17266, 12777]），真正的尺寸靠**节点 TRS** 还原。
    直接拿 min/max × 1000 当毫米，会算出 3700 万毫米这种天文数字。
    按 glTF 规范：有符号归一化整数映射到 [-1, 1]，无符号映射到 [0, 1]。
    """
    if not normalized:
        return float(c)
    if component_type == 5120:   # BYTE
        return max(c / 127.0, -1.0)
    if component_type == 5122:   # SHORT
        return max(c / 32767.0, -1.0)
    if component_type == 5121:   # UNSIGNED_BYTE
        return c / 255.0
    if component_type == 5123:   # UNSIGNED_SHORT
        return c / 65535.0
    if component_type == 5125:   # UNSIGNED_INT
        return c / 4294967295.0
    return float(c)


def accessor_corners(js, idx):
    acc = js["accessors"][idx]
    if "min" not in acc or "max" not in acc:
        return []
    ct, norm = acc["componentType"], acc.get("normalized", False)
    lo = [dequant(v, ct, norm) for v in acc["min"]]
    hi = [dequant(v, ct, norm) for v in acc["max"]]
    return [
        (lo[0] if i & 1 else hi[0], lo[1] if i & 2 else hi[1], lo[2] if i & 4 else hi[2])
        for i in range(8)
    ]


def empty_box():
    return [float("inf")] * 3, [float("-inf")] * 3


def expand(box, pt):
    lo, hi = box
    for i in range(3):
        lo[i] = min(lo[i], pt[i])
        hi[i] = max(hi[i], pt[i])


def box_size(box):
    lo, hi = box
    if lo[0] == float("inf"):
        return [0.0, 0.0, 0.0]
    return [hi[i] - lo[i] for i in range(3)]


def walk(js, idx, parent, rel, out, door):
    """out: [(world_matrix, mesh_index)]；door: 相对门节点本地的 [(rel_matrix, mesh_index)]"""
    node = js["nodes"][idx]
    world = mul(parent, node_local(node))
    inside = rel is not None
    relm = mul(rel, node_local(node)) if inside else None
    if "mesh" in node:
        out.append((world, node["mesh"]))
        if inside:
            door.append((relm, node["mesh"]))
    for c in node.get("children", []):
        walk(js, c, world, relm, out, door)


def subtree(js, idx, parent, out, door):
    walk(js, idx, parent, IDENT if door is not None else None, out, door)


def geometry_box(js, items, base=None):
    """items: [(matrix, mesh_index)] → 世界（或经 base 变换后）的包围盒

    ⚠ 快路径：用 accessor 的 min/max。整体（Cabinet）没问题，
    **门几何不能用这条** —— 见 geometry_box_indexed 的说明。
    """
    box = empty_box()
    for m, mi in items:
        mm = mul(base, m) if base is not None else m
        for prim in js["meshes"][mi].get("primitives", []):
            for pt in accessor_corners(js, prim["attributes"]["POSITION"]):
                expand(box, apply(mm, pt))
    return box


# ------------------------------------------------------- 按索引读（精确路径）
# 踩过的坑：导出器会把 Cabinet 与 DoorSurface 的顶点**合并进同一个 POSITION accessor**
# （demo-ct-scanner 实测：两个 mesh 的 prim0 min/max 逐位相同，只是索引不同）。
# 于是 accessor 的 min/max 是两者的并集 —— 拿它当门几何，门的盒子被撑成整机的盒子，
# 扫掠半径从真值变成"上界"。结论：门这类**子集几何**必须解索引、只统计被引用到的顶点。
_COMP = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def _meshopt_view(js, acc):
    bv = js["bufferViews"][acc["bufferView"]]
    return "extensions" in bv and "EXT_meshopt_compression" in bv["extensions"]


def read_indices(g, js, prim):
    """索引 accessor → [顶点号]；压缩存储 / 无索引 → None"""
    if "indices" not in prim:
        return None
    acc = js["accessors"][prim["indices"]]
    if _meshopt_view(js, acc):
        return None
    fmt, size = _COMP[acc["componentType"]]
    bv = js["bufferViews"][acc["bufferView"]]
    base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = bv.get("byteStride") or size
    data = g["bin_bytes"]
    return [struct.unpack_from("<" + fmt, data, base + i * stride)[0] for i in range(acc["count"])]


def read_positions_minmax(g, js, acc_idx, indices):
    """POSITION 里**被引用到的**顶点 → (lo, hi)（已反量化）；读不了 → None"""
    acc = js["accessors"][acc_idx]
    if _meshopt_view(js, acc):
        return None
    ct, norm = acc["componentType"], acc.get("normalized", False)
    fmt, size = _COMP[ct]
    comps = _NCOMP[acc["type"]]
    bv = js["bufferViews"][acc["bufferView"]]
    base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = bv.get("byteStride") or size * comps
    data = g["bin_bytes"]
    todo = range(acc["count"]) if indices is None else sorted(set(indices))
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    unpack = struct.unpack_from
    for i in todo:
        vals = unpack("<" + fmt * comps, data, base + i * stride)
        for k in range(3):
            v = dequant(vals[k], ct, norm)
            if v < lo[k]:
                lo[k] = v
            if v > hi[k]:
                hi[k] = v
    if lo[0] == float("inf"):
        return None
    return lo, hi


def geometry_box_indexed(g, js, items, base=None):
    """精确包围盒：逐 primitive 解索引 → 只统计被引用到的顶点

    返回 (box, decoded)：decoded=False 表示遇到压缩存储，退回了 accessor 快路径。
    """
    box = empty_box()
    decoded = False
    for m, mi in items:
        mm = mul(base, m) if base is not None else m
        for prim in js["meshes"][mi].get("primitives", []):
            acc_idx = prim["attributes"]["POSITION"]
            r = read_positions_minmax(g, js, acc_idx, read_indices(g, js, prim))
            if r is None:
                for pt in accessor_corners(js, acc_idx):
                    expand(box, apply(mm, pt))
                continue
            decoded = True
            lo, hi = r
            for i in range(8):
                pt = (lo[0] if i & 1 else hi[0], lo[1] if i & 2 else hi[1], lo[2] if i & 4 else hi[2])
                expand(box, apply(mm, pt))
    return box, decoded


def box_center(box):
    lo, hi = box
    if lo[0] == float("inf"):
        return [0.0, 0.0, 0.0]
    return [(lo[i] + hi[i]) / 2.0 for i in range(3)]


def shares_position(js, items_a, items_b):
    """两组 mesh 是否有 primitive 共用同一个 POSITION accessor（共用 → 快路径必错）"""
    def accs(items):
        s = set()
        for _, mi in items:
            for prim in js["meshes"][mi].get("primitives", []):
                s.add(prim["attributes"]["POSITION"])
        return s
    return len(accs(items_a) & accs(items_b)) > 0


def count_triangles(js, items):
    tris = 0
    for _, mi in items:
        for prim in js["meshes"][mi].get("primitives", []):
            if "indices" in prim:
                tris += js["accessors"][prim["indices"]]["count"] // 3
            else:
                tris += js["accessors"][prim["attributes"]["POSITION"]]["count"] // 3
    return tris


def node_map(js):
    return {n.get("name"): i for i, n in enumerate(js.get("nodes", [])) if n.get("name")}


def parent_of(js, idx):
    for i, n in enumerate(js.get("nodes", [])):
        if idx in n.get("children", []):
            return i
    return None


def world_of(js, idx):
    chain = []
    cur = idx
    while cur is not None:
        chain.append(cur)
        cur = parent_of(js, cur)
    m = IDENT
    for i in reversed(chain):
        m = mul(m, node_local(js["nodes"][i]))
    return m


# ---------------------------------------------------------------- 单模型核对
# docs/07 §10.1：GLB 数值单位必须是 m；历史 mm 文件在读取时显式归一化。
# 不靠"看起来差不多"：原始包围盒最大边 > 100 个单位按 mm 处理（真实柜体约 2 m，
# 100 m 以上的模型不是本产品对象），归一化后统一用米算、输出仍用毫米。
UNIT_MM_THRESHOLD = 100.0


def model_unit(raw_size, declared_unit=None):
    """返回 {unit, toM, toMm}；raw_size 是 GLB 节点树实测尺寸（文件单位）。

    `meta.model_unit` 显式声明优先（m/mm）；没有才按尺寸推断，避免把 100 m 的大场景
    误判成 mm，也避免把 mm 文件当 m 用。
    """
    declared_unit = str(declared_unit or "").strip().lower()
    if declared_unit in ("m", "mm"):
        unit = declared_unit
    else:
        longest = max((abs(float(v)) for v in raw_size), default=0.0)
        unit = "mm" if longest > UNIT_MM_THRESHOLD else "m"
    return {"unit": unit, "toM": 0.001 if unit == "mm" else 1.0,
            "toMm": 1.0 if unit == "mm" else 1000.0, "declared": declared_unit or None}


def all_nodes(js):
    return list(enumerate(js.get("nodes", [])))


def name_indices(js):
    out = {}
    for i, n in enumerate(js.get("nodes", [])):
        name = n.get("name")
        if name:
            out.setdefault(name, []).append(i)
    return out


def path_of(js, idx):
    """根→节点名的稳定路径（热点 nodePath 的口径）。"""
    chain = []
    cur = idx
    guard = 0
    while cur is not None and guard < 10000:
        guard += 1
        chain.append(cur)
        cur = parent_of(js, cur)
    names = []
    for i in reversed(chain):
        n = js["nodes"][i]
        names.append(n.get("name") or ("node_%d" % i))
    return "/".join(names)


def path_index(js):
    out = {}
    for i, _ in all_nodes(js):
        out.setdefault(path_of(js, i), []).append(i)
    return out


AUTO_NAME_RE = re.compile(r"^(Object|Cube|Node|Mesh|Group|Scene|Sphere|Cylinder|Plane|Empty)[._]?\d{1,5}$", re.I)
MOVABLE_RE = re.compile(r"(door|lid|drawer|cover|hatch)", re.I)


def anchor_report(js, names, expected_paths=None):
    """锚点清单在**当前文件**里的存在性；同名多处不静默取第一个。"""
    if isinstance(names, str):
        names = [names]
    by_name = name_indices(js)
    paths = path_index(js)
    rows = []
    for raw in names or []:
        if isinstance(raw, dict):
            name = raw.get("name")
            want_path = raw.get("nodePath") or raw.get("path")
        else:
            name, want_path = raw, None
        if not want_path and expected_paths:
            want_path = expected_paths.get(name)
        idxs = by_name.get(name, [])
        found = []
        if want_path:
            for i in idxs:
                if path_of(js, i) == want_path:
                    found.append(i)
            missing_path = not found
        else:
            found = idxs
            missing_path = False
        rows.append({
            "name": name,
            "nodePath": [path_of(js, i) for i in found],
            "found": bool(found),
            "duplicateName": len(idxs) > 1,
            "missingPath": missing_path,
            "indexes": found,
        })
    missing = [r["name"] for r in rows if not r["found"]]
    return {
        "expected": [r["name"] for r in rows],
        "items": rows,
        "missing": missing,
        "ok": (not missing) if rows else None,
    }


def duplicate_siblings(js):
    """同级重名（docs/07 §10.2：供锚点的节点同级应唯一）。装饰件重名只报告，不当硬失败。"""
    out = []
    for i, n in enumerate(js.get("nodes", [])):
        counts = {}
        for c in n.get("children", []):
            name = js["nodes"][c].get("name")
            if name:
                counts[name] = counts.get(name, 0) + 1
        dup = {k: v for k, v in counts.items() if v > 1}
        if dup:
            out.append({"parent": n.get("name") or ("node_%d" % i), "names": dup})
    return out


def structural_hints(js, anchor_names):
    """可动件/自动名/重名提示；不把装饰件重名当失败。"""
    by_name = name_indices(js)
    anchors = set(anchor_names or [])
    movable = []
    auto = []
    for i, n in enumerate(js.get("nodes", [])):
        name = n.get("name") or ""
        if AUTO_NAME_RE.match(name):
            auto.append({"name": name, "path": path_of(js, i)})
        extras = n.get("extras") or {}
        part = str(extras.get("partType") or "")
        if MOVABLE_RE.search(name) or MOVABLE_RE.search(part) or any(
                k in extras for k in ("hinge", "hingeAxis", "hingePoint", "openAngleDeg")):
            movable.append({
                "name": name,
                "path": path_of(js, i),
                "partType": part or None,
                "childCount": len(n.get("children", [])),
                "hasMesh": "mesh" in n,
                "hasHinge": bool(extras.get("hinge")) or any(
                    k in extras for k in ("hingeAxis", "hingePoint", "openAngleDeg")),
            })
    dups = duplicate_siblings(js)
    anchor_dups = [d for d in dups if any(k in anchors for k in d["names"])]
    # 把手/托盘应挂在可动件下：只对“确实存在但往上一层没有可动件”的命名做提示
    hierarchy = []
    for i, n in enumerate(js.get("nodes", [])):
        name = n.get("name") or ""
        if not re.search(r"(handle|grip|tray|basket)", name, re.I):
            continue
        cur = parent_of(js, i)
        under = False
        while cur is not None:
            pn = js["nodes"][cur]
            pe = pn.get("extras") or {}
            if MOVABLE_RE.search(pn.get("name") or "") or MOVABLE_RE.search(str(pe.get("partType") or "")):
                under = True
                break
            cur = parent_of(js, cur)
        if not under:
            hierarchy.append({"name": name, "path": path_of(js, i), "why": "把手/托盘不在门/抽屉/盖节点之下"})
    return {
        "movable": movable,
        "autoNames": auto,
        "duplicateSiblings": dups,
        "anchorDuplicateSiblings": anchor_dups,
        "hierarchyWarnings": hierarchy,
    }


def unit_mismatch(bbox_mm, declared_mm):
    """声明 mm 与实测 mm 是否差 ~1000 倍（docs/07 §10.1 的 unit-mismatch）。"""
    if not declared_mm:
        return False
    ratios = []
    for k in ("w", "h", "d"):
        d = float(declared_mm.get(k) or 0)
        a = float(bbox_mm.get(k) or 0)
        if d > 0 and a > 0:
            ratios.append(a / d)
    if not ratios:
        return False
    return any(r < 0.01 or r > 100 for r in ratios)


def verify(entry, glb_path=None, ref_bbox=None, tol=1.0, ref_anchor_paths=None):
    path = Path(glb_path) if glb_path else ROOT / entry["asset"]["file"]
    rel = path.relative_to(ROOT).as_posix() if str(path).startswith(str(ROOT)) else str(path)
    g = parse_glb(path)
    js = g["js"]
    scene = js["scenes"][js.get("scene", 0)]

    all_items, _ = [], None
    for r in scene["nodes"]:
        walk(js, r, IDENT, None, all_items, None)
    # 整体包围盒也走精确路径：快路径在共用 accessor 时会把尺寸**放大**，
    # 而加载器的等比缩放正是拿它当分母 —— 两侧同源才不会互相打架
    body_box, all_decoded = geometry_box_indexed(g, js, all_items)
    body_box_fast = geometry_box(js, all_items)
    size = box_size(body_box)
    unit = model_unit(size, entry.get("model_unit") or entry.get("modelUnit"))
    to_mm = unit["toMm"]

    # docs/07 §10.1：文件单位 m、声明单位 mm。历史 mm 文件显式归一化后再对账；
    # 这里不静默把 mm 当 m —— sourceUnit 会随结果回传。
    declared_mm = {"w": entry["w"], "h": entry["h"], "d": entry["d"]} if all(
        isinstance(entry.get(k), (int, float)) for k in ("w", "h", "d")) else None
    bbox_mm = {"w": round(size[0] * to_mm, 3), "h": round(size[1] * to_mm, 3),
               "d": round(size[2] * to_mm, 3)}

    result = {
        "productId": entry["id"],
        "assetId": entry["assetId"],
        "modelCode": entry["modelCode"],
        "file": rel,
        "assetFile": entry["asset"]["file"],
        "bytes": g["bytes"],
        "md5": entry["asset"]["md5"],
        "generator": js.get("asset", {}).get("generator"),
        "truncated": g["truncated"],
        "triangles": count_triangles(js, all_items),
        "meshes": len(js.get("meshes", [])),
        "materials": len(js.get("materials", [])),
        "textures": len(js.get("images", [])),
        "nodes": len(js.get("nodes", [])),
        # glTF 是 Y 向上：x = 宽 w，y = 高 h，z = 深 d
        "sourceUnit": unit["unit"],
        "unitScaleToM": unit["toM"],
        "bboxMm": bbox_mm,
        "declaredMm": declared_mm,
        # bbox 两端与中心（模型本地坐标，毫米）：加载器拿中心把原点挪到底面中心，
        # 2D 平面图也要用同一个中心把"门铰链"换算到平面坐标 —— 两边必须同源
        "bboxMinMm": [round(v * to_mm, 3) for v in body_box[0]],
        "bboxMaxMm": [round(v * to_mm, 3) for v in body_box[1]],
        "bboxCenterMm": [round(v * to_mm, 3) for v in box_center(body_box)],
        "bboxExact": all_decoded,   # False = 有压缩存储读不出，值退回 accessor 快路径
    }
    fast_size = box_size(body_box_fast)
    if max(abs(fast_size[i] - size[i]) for i in range(3)) * to_mm > 0.5:
        result["bboxByAccessorMm"] = {k: round(fast_size[i] * to_mm, 3) for i, k in enumerate("whd")}
        result["bboxNote"] = "快路径（accessor min/max）与逐顶点精确值不一致，已采用精确值"
    result["deltaMm"] = ({k: round(result["bboxMm"][k] - result["declaredMm"][k], 3)
                          for k in ("w", "h", "d")} if declared_mm else None)
    result["unitMismatch"] = unit_mismatch(result["bboxMm"], declared_mm)

    # 三种核对口径：
    #   优化产物  与"源模型实测包围盒"比 —— 不能拿声明包络当基准，
    #              因为配方模型本来就与声明值不等（那是加载器缩放兜的）
    #   官方模型  1:1 直接进场景，不缩放 → 实测必须等于声明包络（这才是"测量值"该有的样子）
    #   配方/重建 加载器按 s = min(w/sx, h/sy, d/sz) 等比缩放兜底 → 看 s 与"比例被扭了多少"
    if ref_bbox is not None:
        result["envelopeMode"] = "optimized"
        result["refMm"] = ref_bbox
        result["deltaVsSourceMm"] = {k: round(result["bboxMm"][k] - ref_bbox[k], 3) for k in ("w", "h", "d")}
        result["toleranceMm"] = tol
        result["envelopeOk"] = all(abs(v) <= tol for v in result["deltaVsSourceMm"].values())
    elif not declared_mm:
        result["envelopeMode"] = "unknown"
        result["envelopeOk"] = None
    elif entry.get("recipeId"):
        result["envelopeMode"] = "fit"
        ratios = {k: result["declaredMm"][k] / result["bboxMm"][k]
                  for k in ("w", "h", "d") if result["bboxMm"][k] > 0}
        s = min(ratios.values())
        result["fitScale"] = round(s, 4)
        result["anisotropyPct"] = round((max(ratios.values()) / min(ratios.values()) - 1) * 100, 2)
        result["fittedMm"] = {k: round(result["bboxMm"][k] * s, 1) for k in ("w", "h", "d")}
        result["envelopeOk"] = s <= 1.0        # 缩放后能放进声明包络
        # 容差同样问参数表（`model.anisotropyWarn` 是**倍数**，这里是百分比）—— 第 2 轮审查 dev-5
        result["anisotropyOk"] = result["anisotropyPct"] <= (param("model.anisotropyWarn", 1.02) - 1) * 100
    else:
        result["envelopeMode"] = "1:1" if declared_mm else "unknown"
        # 1:1 的对账容差与写入侧（`analyze.js` / `AdminBadges`）**同一处出处**（第 3 轮审查 C-10）
        result["envelopeOk"] = (all(
            abs(v) <= param("model.envelopeTolMm", 1.0) for v in result["deltaMm"].values()
        ) if declared_mm else None)

    result["budgets"] = {
        "triangles": {"limit": LIMIT_TRIANGLES, "actual": result["triangles"], "pass": result["triangles"] <= LIMIT_TRIANGLES},
        "bytes": {"limit": LIMIT_BYTES, "actual": g["bytes"], "pass": g["bytes"] <= LIMIT_BYTES},
        "textures": {"limit": LIMIT_TEXTURES, "actual": result["textures"], "pass": result["textures"] <= LIMIT_TEXTURES},
    }

    # ---- 门 ----
    names = node_map(js)
    result["doors"] = []
    # 柜体 = 整机去掉**所有**声明的门（多门型号一次算完，不必每扇门重算）
    all_door_meshes = set()
    for d0 in entry.get("doors", []):
        i0 = names.get(d0["node"])
        if i0 is None:
            continue
        items0 = []
        n0 = js["nodes"][i0]
        p0 = world_of(js, parent_of(js, i0)) if parent_of(js, i0) is not None else IDENT
        w0 = mul(p0, node_local(n0))
        if "mesh" in n0:
            items0.append((w0, n0["mesh"]))
        for c in n0.get("children", []):
            subtree(js, c, w0, items0, None)
        all_door_meshes |= {mi for _, mi in items0}
    body_only = [(m, mi) for m, mi in all_items if mi not in all_door_meshes]
    cabinet_box, _ = geometry_box_indexed(g, js, body_only)   # 整机去掉门 = 柜体

    for d in entry["doors"]:
        idx = names.get(d["node"])
        if idx is None:
            result["doors"].append({"node": d["node"], "status": "node-not-found", "expected": d})
            continue
        door_items, rel_items = [], []
        node = js["nodes"][idx]
        parent = world_of(js, parent_of(js, idx)) if parent_of(js, idx) is not None else IDENT
        closed_world = mul(parent, node_local(node))
        open_world = mul(parent, replace_rotation(node, d["axis"], d["openAngleRad"]))
        if "mesh" in node:
            door_items.append((closed_world, node["mesh"]))
            rel_items.append((IDENT, node["mesh"]))
        for c in node.get("children", []):
            subtree(js, c, closed_world, door_items, rel_items)

        # 精确路径：门是整机的子集，必须按索引统计（否则盒子=整机盒子，半径只是上界）
        shared = shares_position(js, door_items, body_only)
        closed_box, door_decoded = geometry_box_indexed(g, js, door_items)
        rel_box, _ = geometry_box_indexed(g, js, [(m, mi) for m, mi in rel_items])
        upper_box = geometry_box(js, [(m, mi) for m, mi in rel_items])   # 快路径（上界），留着对比
        lo, hi = rel_box
        ang = d["openAngleRad"]
        ca, sa = math.cos(ang), math.sin(ang)
        ai = "xyz".index(d["axis"])

        def spin(p):
            x, y, z = p
            if ai == 1:
                return (x * ca + z * sa, y, -x * sa + z * ca)
            if ai == 0:
                return (x, y * ca - z * sa, y * sa + z * ca)
            return (x * ca - y * sa, x * sa + y * ca, z)

        open_box = empty_box()
        for i in range(8):
            corner = (lo[0] if i & 1 else hi[0], lo[1] if i & 2 else hi[1], lo[2] if i & 4 else hi[2])
            expand(open_box, apply(open_world, spin(corner)))

        # 扫掠半径：铰链轴（门节点原点）到门几何最远处的水平距离 → 2D 扇形半径
        axis_pt = apply(closed_world, (0, 0, 0))
        radius = 0.0
        for i in range(8):
            corner = (lo[0] if i & 1 else hi[0], lo[1] if i & 2 else hi[1], lo[2] if i & 4 else hi[2])
            w = apply(closed_world, corner)
            horiz = [w[k] - axis_pt[k] for k in range(3) if k != ai]
            radius = max(radius, math.hypot(*horiz))
        ulo, uhi = upper_box
        upper_radius = 0.0
        for i in range(8):
            corner = (ulo[0] if i & 1 else uhi[0], ulo[1] if i & 2 else uhi[1], ulo[2] if i & 4 else uhi[2])
            w = apply(closed_world, corner)
            horiz = [w[k] - axis_pt[k] for k in range(3) if k != ai]
            upper_radius = max(upper_radius, math.hypot(*horiz))

        # 方向判定：开门后门几何是否越出柜体包围盒
        #   swingsIntoBody —— 开门后仍整体包在柜体包围盒里（方向反了，或门根本没动）
        #   openExtraMm    —— 非铰链轴方向上的最大外扩量（正数=真的伸出去了）
        body_axes = [i for i in range(3) if i != ai]
        ext_out = max(max(open_box[1][i] - cabinet_box[1][i], cabinet_box[0][i] - open_box[0][i]) for i in body_axes)
        inside = all(open_box[0][i] >= cabinet_box[0][i] and open_box[1][i] <= cabinet_box[1][i] for i in body_axes)
        worst_out = max(body_axes, key=lambda i: max(open_box[1][i] - cabinet_box[1][i], cabinet_box[0][i] - open_box[0][i]))
        result["doors"].append({
            "node": d["node"],
            "axis": d["axis"],
            "angleDeg": round(math.degrees(d["openAngleRad"]), 2),
            "pivotMm": [round(v * to_mm, 2) for v in axis_pt],
            "swingRadiusMm": round(radius * to_mm, 2),
            "swingUpperMm": round(upper_radius * to_mm, 2),
            "closedSizeMm": [round(v * to_mm, 2) for v in box_size(closed_box)],
            # 门自己（而非整机）的盒子两端，模型本地坐标毫米：
            # 铰链在哪一端、门扇有多长，2D 平面图靠这两个值定，不再拿柜宽猜
            "closedMinMm": [round(v * to_mm, 2) for v in closed_box[0]],
            "closedMaxMm": [round(v * to_mm, 2) for v in closed_box[1]],
            "openExtraMm": round(ext_out * to_mm, 2),
            "swingsIntoBody": inside,
            "extendsAxis": "xyz"[worst_out],
            # 这扇门的几何是不是"逐顶点精确"算的（False=压缩存储读不出，值只是上界）
            "geometryExact": door_decoded,
            # POSITION accessor 与柜体共用吗（共用 = "必须按索引算"的成因，写进数据便于事后解释）
            "sharedPositionAccessor": shared,
            "status": "ok",
        })
    anchor_names = entry.get("anchor_nodes") or [d.get("node") for d in entry.get("doors", [])]
    result["anchorNames"] = anchor_names
    result["anchors"] = anchor_report(js, anchor_names, ref_anchor_paths)
    result["anchorSource"] = "meta.anchor_nodes" if entry.get("anchor_nodes") else "doors[].node"
    result["anchorOk"] = result["anchors"]["ok"]
    result["structure"] = structural_hints(js, anchor_names)
    return result


def optimized_dir_from_argv():
    """压缩产物目录：默认 assets/optimized（存在就核对）。

    踩过的坑：以前**只有**带 `--dir` 才核对压缩产物，而 JSON 是整体重写的 ——
    于是 `python verify-models.py`（不带参数）会把上一次的 optimized 那 10 条静默删掉，
    产物看起来正常、数量莫名变少。现在默认就核对，`--dir <目录>` 只用于换目录。
    目录不存在（还没做压缩之前）时返回 None，不影响第一次跑。
    """
    if "--dir" in sys.argv:
        i = sys.argv.index("--dir")
        nxt = sys.argv[i + 1] if i + 1 < len(sys.argv) else None
        return Path(nxt) if nxt and not nxt.startswith("--") else ROOT / "assets" / "optimized"
    default = ROOT / "assets" / "optimized"
    return default if default.is_dir() else None


def inspect_glb(path):
    """独立检查一个 GLB（不要求它在 products.json 里；297/298 这类新增件用）。"""
    path = Path(path)
    g = parse_glb(path)
    entry = {
        "id": path.stem, "assetId": path.stem, "modelCode": path.name,
        "asset": {"file": str(path), "md5": "", "bytes": g["bytes"]},
        "doors": [],
    }
    return verify(entry, glb_path=path)


def main():
    if "--glb" in sys.argv:
        i = sys.argv.index("--glb")
        files = [x for x in sys.argv[i + 1:] if not x.startswith("--")]
        if not files:
            print("用法：python tools/models/verify-models.py --glb <文件.glb> [更多 .glb]")
            return 2
        for f in files:
            r = inspect_glb(f)
            print("\n" + "=" * 78)
            print("%s  源单位 %s  (→ m 系数 %s)" % (f, r["sourceUnit"], r["unitScaleToM"]))
            print("  实测包围盒 %8.3f × %8.3f × %8.3f mm（已按源单位归一化）"
                  % (r["bboxMm"]["w"], r["bboxMm"]["h"], r["bboxMm"]["d"]))
            print("  节点/网格/材质/贴图 %d/%d/%d/%d  三角面 %s"
                  % (r["nodes"], r["meshes"], r["materials"], r["textures"], format(r["triangles"], ",")))
            print("  锚点：未提供 meta.anchor_nodes（独立件）；可动件 %d 个，自动名 %d 个，同级重名 %d 处"
                  % (len(r["structure"]["movable"]), len(r["structure"]["autoNames"]),
                     len(r["structure"]["duplicateSiblings"])))
            if r["structure"]["hierarchyWarnings"]:
                for h in r["structure"]["hierarchyWarnings"][:5]:
                    print("    ⚠ %s：%s" % (h["path"], h["why"]))
            print(json.dumps(r, ensure_ascii=False, indent=2) if "--json" in sys.argv else "")
        return 0

    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    quiet = "--json" in sys.argv
    models = []
    for p in catalog["products"]:
        if not p.get("asset"):
            continue
        r = verify(p)
        models.append(r)
        if quiet:
            continue
        print("\n" + "=" * 78)
        print("%s  %s  (%s)" % (r["productId"].ljust(6), r["modelCode"], r["file"]))
        print("  文件      %.2f MB   三角面 %s   网格/材质/贴图 %d/%d/%d%s"
              % (r["bytes"] / 1048576, format(r["triangles"], ","), r["meshes"], r["materials"], r["textures"],
                 "   ⚠ 截断" if r["truncated"] else ""))
        print("  源单位 %s（→ m 系数 %s）  实测包围盒 %8.3f × %8.3f × %8.3f mm  (w × h × d)"
              % (r["sourceUnit"], r["unitScaleToM"], r["bboxMm"]["w"], r["bboxMm"]["h"], r["bboxMm"]["d"]))
        a = r["anchors"]
        print("  锚点 %s  %s" % ("无清单" if a["ok"] is None else ("✓ 全部存在" if a["ok"] else "✗ 缺失 " + ", ".join(a["missing"])),
                                "（门节点兜底）" if r.get("anchorSource") == "doors[].node" else "（meta.anchor_nodes）"))
        if r.get("unitMismatch"):
            print("  ✗ 单位对账   声明 %s mm 与实测 %s mm 差约 1000 倍（unit-mismatch，拒绝入库）"
                  % (r["declaredMm"], r["bboxMm"]))
        verdict = "✓ 一致" if r["envelopeOk"] else "✗ 不一致"
        print("  声明包络   %8.3f × %8.3f × %8.3f mm   Δ %+.3f / %+.3f / %+.3f   %s"
              % (r["declaredMm"]["w"], r["declaredMm"]["h"], r["declaredMm"]["d"],
                 r["deltaMm"]["w"], r["deltaMm"]["h"], r["deltaMm"]["d"], verdict if r["envelopeMode"] == "1:1" else "（配方模型，见下）"))
        if r["envelopeMode"] == "fit":
            print("  加载口径   加载器等比缩放兜底  s=%.4f → 缩放后 %.1f × %.1f × %.1f mm；各轴比例差 %.2f%% %s"
                  % (r["fitScale"], r["fittedMm"]["w"], r["fittedMm"]["h"], r["fittedMm"]["d"], r["anisotropyPct"],
                     "✓" if r["anisotropyOk"] else "✗ 形状失真（>2%）"))
        else:
            print("  加载口径   1:1 直接进场景，不缩放")
        b = r["budgets"]
        print("  预算      面数 %s/%s %s   体积 %.1f/%s MB %s"
              % (format(b["triangles"]["actual"], ","), format(b["triangles"]["limit"], ","), "✓" if b["triangles"]["pass"] else "✗ 超",
                 b["bytes"]["actual"] / 1048576, b["bytes"]["limit"] // 1048576, "✓" if b["bytes"]["pass"] else "✗ 超"))
        for d in r["doors"]:
            if d.get("status") != "ok":
                print("  门 %-12s ✗ %s" % (d["node"], d.get("status")))
                continue
            print("  门 %-12s 轴 %s  开角 %7.2f°  扫掠半径 %7.1f mm  开门后外扩 %+8.1f mm  %s"
                  % (d["node"], d["axis"], d["angleDeg"], d["swingRadiusMm"], d["openExtraMm"],
                     "✗ 开门后仍在柜体包围盒内（方向疑似反了）" if d["swingsIntoBody"] else "✓ 向柜外开"))

    # ---- 压缩产物核对（--dir）----
    optimized = []
    opt_dir = optimized_dir_from_argv()
    if opt_dir:
        refs = {m["assetId"]: m["bboxMm"] for m in models}
        ref_anchor_paths = {}
        for m in models:
            for a in m["anchors"]["items"]:
                if a["nodePath"]:
                    ref_anchor_paths.setdefault(m["assetId"], {})[a["name"]] = a["nodePath"][0]
        entries = {p["assetId"]: p for p in catalog["products"] if p.get("asset")}
        print("\n" + "=" * 78)
        print("压缩产物核对：%s   基准=源模型实测包围盒，容差 5 mm" % opt_dir.relative_to(ROOT))
        for f in sorted(opt_dir.glob("*.glb")):
            aid = max((k for k in entries if f.name.startswith(k)), key=len, default=None)
            if not aid:
                print("  %-42s ✗ 匹配不到目录条目" % f.name)
                continue
            r = verify(entries[aid], glb_path=f, ref_bbox=refs[aid], tol=5.0)
            r["lod"] = f.stem.split(".")[-1]
            r["sourceBytes"] = entries[aid]["asset"]["bytes"]
            r["compressionPct"] = round((1 - r["bytes"] / max(entries[aid]["asset"]["bytes"], 1)) * 100, 2)
            optimized.append(r)
            d = r["deltaVsSourceMm"]
            lost_doors = [dd["node"] for dd in r["doors"] if dd.get("status") != "ok"]
            lost_anchors = r["anchors"]["missing"] if r["anchors"]["ok"] is False else []
            print("  %-38s %5.2f MB  %7s 面  源 %5.2f MB（降 %5.1f%%）  与源差 %+.2f/%+.2f/%+.2f mm  %s%s%s"
                  % (f.name, r["bytes"] / 1048576, format(r["triangles"], ","), r["sourceBytes"] / 1048576,
                     r["compressionPct"], d["w"], d["h"], d["d"],
                     "✓" if r["envelopeOk"] else "✗ 超容差",
                     "" if not lost_anchors else "   ✗ 锚点丢失：%s" % ", ".join(lost_anchors),
                     "" if not lost_doors else "   ✗ 门节点丢失：%s" % ", ".join(lost_doors)))

    OUT_TEXT = json.dumps({
        "note": "由 tools/models/verify-models.py 生成：实测包围盒 vs 声明包络、性能预算、门几何。swingRadiusMm 供 2D 扇形直接用，不必再拿柜体宽度估。",
        "generatedAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "units": "mm",
        "limits": {"triangles": LIMIT_TRIANGLES, "bytes": LIMIT_BYTES, "textures": LIMIT_TEXTURES},
        "models": models,
        **({"optimized": optimized} if optimized else {}),
    }, ensure_ascii=False, indent=2)
    if "--no-write" not in sys.argv:
        OUT.write_text(OUT_TEXT, encoding="utf-8")

    # 只有 1:1 模型用"包络必须一致"判成败；配方模型本来就靠缩放兜底，看"形状比例失真"那行
    bad_env = [m for m in models if m["envelopeMode"] == "1:1" and not m["envelopeOk"]]
    unit_bad = [m for m in models if m.get("unitMismatch")]
    bad_anchor = [m for m in models if m.get("anchorOk") is False]
    aniso = [m for m in models if m.get("envelopeMode") == "fit" and not m.get("anisotropyOk", True)]
    over = [m for m in models if not (m["budgets"]["triangles"]["pass"] and m["budgets"]["bytes"]["pass"])]
    ids = lambda ms: ", ".join(m["productId"] for m in ms)
    print("\n" + "-" * 78)
    print("核对 %d 个模型" % len(models))
    print("  1:1 模型包络   %s" % (("%d 个不一致：%s" % (len(bad_env), ids(bad_env))) if bad_env else "全部一致 ✓"))
    print("  单位/锚点      %s；%s" % (
        ("%d 个单位差 1000 倍：%s" % (len(unit_bad), ids(unit_bad))) if unit_bad else "单位全部一致 ✓",
        ("%d 个锚点缺失：%s" % (len(bad_anchor), ids(bad_anchor))) if bad_anchor else "锚点全部存在 ✓"))
    print("  形状比例失真   %s" % (("%d 个超 2%%：%s" % (len(aniso), ", ".join("%s %.2f%%" % (m["productId"], m["anisotropyPct"]) for m in aniso))) if aniso else "全部在 2% 内 ✓"))
    print("  性能预算       %s" % (("%d 个超预算：%s" % (len(over), ids(over))) if over else "全部达标 ✓"))
    if optimized:
        bad_opt = [m for m in optimized if not m["envelopeOk"]]
        lost = ["%s/%s" % (m["lod"], d["node"]) for m in optimized for d in m["doors"] if d.get("status") != "ok"]
        lost_a = ["%s/%s" % (m["lod"], a) for m in optimized for a in (m["anchors"]["missing"] if m["anchors"]["ok"] is False else [])]
        print("  压缩产物       %d 个文件，体积最大降幅 %.1f%%，几何 %s，门节点 %s，锚点 %s"
              % (len(optimized), max(m["compressionPct"] for m in optimized),
                 "全部在容差内 ✓" if not bad_opt else "%d 个超容差：%s" % (len(bad_opt), ids(bad_opt)),
                 "全部保留 ✓" if not lost else "丢失：%s" % ", ".join(lost),
                 "全部存在 ✓" if not lost_a else "丢失：%s" % ", ".join(lost_a)))
    print("（--no-write，未写 %s）" % OUT.relative_to(ROOT) if "--no-write" in sys.argv else "已写入 %s" % OUT.relative_to(ROOT))
    ok = (not bad_env and not unit_bad and not bad_anchor
          and not [m for m in optimized if not m["envelopeOk"]
                   or any(d.get("status") != "ok" for d in m["doors"])
                   or m["anchors"]["ok"] is False])
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())