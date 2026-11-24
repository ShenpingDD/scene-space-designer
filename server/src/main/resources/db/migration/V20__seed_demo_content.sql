-- 演示机型「样品搅拌机（演示）」的内容与 3 条热点（演示数据，不是真实产品的宣传文案）。
--
-- 为什么要随迁移发布：热点是「内容」而不是「几何」——模型只提供节点与几何，
-- 哪一点值得标注、标注说什么，只能由数据给出。没有这份种子，公开仓开箱的演示机型
-- 是「模型看得见、热点为空」的，README 里那张详情页截图也就对不上。
--
-- 幂等：内容走 ON DUPLICATE KEY UPDATE；热点按产品整删整插（它们的 id 只在本产品内有意义）。
-- 注意 published_json 里的 validation.modelFingerprint 必须与 product_model.checksum 同源
-- （default:<md5>）；模型换了而这里没换，全部热点会被判 model-changed —— 这是刻意的护栏。

DELETE FROM product_hotspot WHERE product_id = 6;

INSERT INTO product_content
  (product_id, draft_json, published_json, rev, published_rev, published_at, updated_by)
VALUES
  (6, '{"params": [{"key": "外形尺寸", "unit": "mm", "group": "整机", "value": "676 × 672 × 1310.5"}, {"key": "台面高度", "unit": "mm", "group": "整机", "value": "930.5"}, {"key": "台面尺寸", "unit": "mm", "group": "整机", "value": "640 × 600"}, {"key": "门开启角度", "unit": "°", "group": "门", "value": "106"}, {"key": "搁板层数", "unit": "层", "group": "内部", "value": "2"}, {"key": "整机功率", "unit": "kW", "group": "电气", "value": "0.75"}], "validation": {"unit": "", "invalid": [], "checkedAt": "2026-11-25T02:09:35.652371+08:00", "modelFingerprint": ""}, "sellingPoints": ["台面 1.2 mm 不锈钢，前缘折边 + 后侧挡水，液体不外溢", "两层搁板可调，单开门开启 106° —— 开门净空按模型实测的铰链位算，不靠估", "底部带可调地脚与踢脚板，地面不平也能调平；台面孔位可按需开孔"]}', '{"model": {"file": "assets/optimized/demo-blender-001.lod0.glb", "unit": "mm", "bboxMm": {"d": 672, "h": 1310.5, "w": 676}, "modelId": 1, "variant": "default", "checksum": "e66e5c586b48b71fd8595ad414dacdcf", "declared": {"d": 672, "h": 1310.5, "w": 676}, "hingeNodes": [{"axis": "y", "leaf": {"x0": -0.26, "x1": 0.296, "z0": 0.272, "z1": 0.336}, "node": "door_single", "exact": true, "hinge": {"x": -0.26, "y": 0.1905, "z": 0.285}, "nodes": ["door_single"], "swing": 0.55833, "openExtra": 0.42057, "openAngleDeg": 106, "sharedAccessor": false}]}, "actions": [], "content": {"params": [{"key": "外形尺寸", "unit": "mm", "group": "整机", "value": "676 × 672 × 1310.5"}, {"key": "台面高度", "unit": "mm", "group": "整机", "value": "930.5"}, {"key": "台面尺寸", "unit": "mm", "group": "整机", "value": "640 × 600"}, {"key": "门开启角度", "unit": "°", "group": "门", "value": "106"}, {"key": "搁板层数", "unit": "层", "group": "内部", "value": "2"}, {"key": "整机功率", "unit": "kW", "group": "电气", "value": "0.75"}], "description": "演示用机型：唯一随仓库发布 3D 模型的机型。声明包络与实测包围盒逐轴相等（1:1），门是模型里量出来的真铰链门（door_single，绕竖轴 106°）。用于演示三维载入、门开合与门净空判据。", "sellingPoints": ["台面 1.2 mm 不锈钢，前缘折边 + 后侧挡水，液体不外溢", "两层搁板可调，单开门开启 106° —— 开门净空按模型实测的铰链位算，不靠估", "底部带可调地脚与踢脚板，地面不平也能调平；台面孔位可按需开孔"]}, "hotspots": [{"id": 1, "seq": 0, "body": "1.2 mm 不锈钢台面，前缘折边、后侧挡水；台面开口可按设备需要开孔。", "title": "不锈钢台面", "camera": {"fov": 42, "target": [0.5, 0.74, 0.5], "azimuthDeg": 24, "distFactor": 1.5, "elevationDeg": 30}, "normal": {"x": 0, "y": 1, "z": 0}, "nodeName": "worktop", "nodePath": ["worktop"], "position": {"x": 0, "y": 0.016, "z": 0.15}, "actionKey": null, "doorState": "any", "nodeIndex": 0}, {"id": 2, "seq": 1, "body": "上层与下层搁板均为可调高度；开门后才看得到内部，所以这条热点只在门打开时出现。", "title": "两层可调搁板", "camera": {"fov": 42, "target": [0.5, 0.5, 0.55], "azimuthDeg": 12, "distFactor": 1.2, "elevationDeg": 6}, "normal": {"x": 0, "y": 0, "z": 1}, "nodeName": "shelf_upper", "nodePath": ["shelf_upper"], "position": {"x": 0, "y": 0.007, "z": 0.259}, "actionKey": null, "doorState": "open", "nodeIndex": 0}, {"id": 3, "seq": 2, "body": "铰链位置与开合角度从模型量出来，门宽 556 mm；布局里的开门净空就是按这个角度判的。", "title": "单开门 · 开启 106°", "camera": {"fov": 42, "target": [0.5, 0.3, 0.85], "azimuthDeg": 8, "distFactor": 1.35, "elevationDeg": 8}, "normal": {"x": 0, "y": 0, "z": 1}, "nodeName": "front_rail", "nodePath": ["front_rail"], "position": {"x": 0, "y": 0, "z": 0.008}, "actionKey": null, "doorState": "any", "nodeIndex": 0}], "validation": {"unit": "mm", "invalid": [], "checkedAt": "2026-11-25T02:09:35.652371+08:00", "modelFingerprint": "default:e66e5c586b48b71fd8595ad414dacdcf"}, "publishedAt": "2026-11-25T02:09:43.096599+08:00", "publishedRev": 2}', 2, 2, '2026-11-25 02:09:43.097', '管理员')
ON DUPLICATE KEY UPDATE
  draft_json = VALUES(draft_json),
  published_json = VALUES(published_json),
  rev = VALUES(rev),
  published_rev = VALUES(published_rev),
  published_at = VALUES(published_at),
  updated_by = VALUES(updated_by);

INSERT INTO product_hotspot
  (product_id, seq, title, body, node_path, node_index, node_name,
   pos_x, pos_y, pos_z, nrm_x, nrm_y, nrm_z, door_state, camera_json,
   model_id, media_file, media_alt, action_key)
VALUES
  (6, 0, '不锈钢台面', '1.2 mm 不锈钢台面，前缘折边、后侧挡水；台面开口可按设备需要开孔。', '["worktop"]', 0, 'worktop', 0.0000, 0.0160, 0.1500, 0.00000, 1.00000, 0.00000, 'any', '{"fov": 42, "target": [0.5, 0.74, 0.5], "azimuthDeg": 24, "distFactor": 1.5, "elevationDeg": 30}', 1, '', '', 'NULL'),
  (6, 1, '两层可调搁板', '上层与下层搁板均为可调高度；开门后才看得到内部，所以这条热点只在门打开时出现。', '["shelf_upper"]', 0, 'shelf_upper', 0.0000, 0.0070, 0.2590, 0.00000, 0.00000, 1.00000, 'open', '{"fov": 42, "target": [0.5, 0.5, 0.55], "azimuthDeg": 12, "distFactor": 1.2, "elevationDeg": 6}', 1, '', '', 'NULL'),
  (6, 2, '单开门 · 开启 106°', '铰链位置与开合角度从模型量出来，门宽 556 mm；布局里的开门净空就是按这个角度判的。', '["front_rail"]', 0, 'front_rail', 0.0000, 0.0000, 0.0080, 0.00000, 0.00000, 1.00000, 'any', '{"fov": 42, "target": [0.5, 0.3, 0.85], "azimuthDeg": 8, "distFactor": 1.35, "elevationDeg": 8}', 1, '', '', 'NULL');
