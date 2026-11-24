-- R__seed_product_catalog.sql —— 演示产品目录（可重复执行的种子，**公开仓演示数据**）
--
-- 为什么是 R__ 而不是 V2：V2 已随库发布、被 Flyway 校验 checksum，改它会让已有环境启动不了；
-- 而目录是会变的（加型号 / 改文案 / 补说明条目）→ 派生物放这里，内容一变就重跑，语句全部幂等。
--
-- 与 V2 的分工：V2 给 6 款演示产品建行并插一条演示模型的 product_model；
-- 这里按 `model_no` upsert 明细列（介绍 / 来源 / 尺寸可信度 / 门型 / 颜色）与说明条目。
-- 两份必须同口径：model_no 是**锚点**，运行时 id 取 `recipe_json.id`。

-- ① 产品基础信息（介绍/来源/尺寸可信度/色标原来是 recipe_json 里的字段，现在立成列）
INSERT INTO `product` (`model_no`, `name`, `series`, `description`, `origin`, `size_note`, `door_part`, `color`, `source_url`, `status`, `recipe_json`, `sort_order`) VALUES
  ('DEMO-CT-100', 'CT 扫描仪（演示）', '', '演示用机型：一台占地较大的设备，用于演示占地判据、贴墙摆放与通道宽度。它不随仓库发布 3D 模型，三维视图为空 —— 这正是「只有声明、没有模型」那条路径的样子。尺寸为演示设定。', '合成演示数据', '演示设定 · 非产品尺寸', NULL, '#187fb0', '', 'active', '{"id":"demo-ct-scanner","name":"CT 扫描仪（演示）","modelCode":"DEMO-CT-100","w":3045,"d":2470,"h":2138.117,"color":"#187fb0","origin":"合成演示数据","sizeNote":"演示设定 · 非产品尺寸","desc":"演示用机型：一台占地较大的设备，用于演示占地判据、贴墙摆放与通道宽度。它不随仓库发布 3D 模型，三维视图为空 —— 这正是「只有声明、没有模型」那条路径的样子。尺寸为演示设定。","facts":[["外形","立式，矩形包络"],["三维模型","无（只声明包络）"]],"features":[["尺寸口径","3045 × 2470 × 2138 mm 是演示设定，不是实测值，也不对应任何真实设备。"],["三维视图","没有随仓库发布的模型，切到三维是空的 —— 这是刻意保留的路径。"],["用途","演示占地与通道判据，不代表任何真实设备的规格。"]],"sourceUrl":null,"recipeId":"demo-ct-scanner","assetId":null,"doors":[],"doorVerified":false}', 0),
  ('DEMO-FZ-040', '双门机柜（演示）', '', '演示用机型：上下双门的立式机柜。用于演示对开门、门净空与并排摆放的判据；尺寸与参数均为演示设定。', '合成演示数据', '演示设定 · 非产品尺寸', 'double', '#286eac', '', 'active', '{"id":"demo-freezer-dual","name":"双门机柜（演示）","modelCode":"DEMO-FZ-040","w":990,"d":871.2,"h":1980,"color":"#286eac","origin":"合成演示数据","sizeNote":"演示设定 · 非产品尺寸","desc":"演示用机型：上下双门的立式机柜。用于演示对开门、门净空与并排摆放的判据；尺寸与参数均为演示设定。","facts":[["外形","立式，上下双门"],["门","对开双门，绕竖轴开启"],["摆放","适合并排布置"]],"features":[["独立双控","上下门独立开合 —— 演示用文案。"],["存储结构","内部层板的示意配置。"],["开门方式","对开双门，绕竖轴开启。"]],"sourceUrl":null,"recipeId":"demo-freezer-dual","assetId":null,"doors":[{"node":"upper_door","axis":"y","openAngleRad":1.85,"openAngleDeg":106,"hinge":{"x":0.41748,"y":1.25119,"z":0.32944},"leaf":{"x0":-0.44276,"x1":0.43939,"z0":0.2831,"z1":0.4356},"swing":0.86676,"pivot":[0.235,0.7425,0.234]},{"node":"lower_door","axis":"y","openAngleRad":1.85,"openAngleDeg":106,"hinge":{"x":0.41748,"y":0.35,"z":0.32944},"leaf":{"x0":-0.44276,"x1":0.43939,"z0":0.2831,"z1":0.4356},"swing":0.86676,"pivot":[0.235,0.35,0.234]}],"doorVerified":false}', 1),
  ('DEMO-FZ-25U', '单门储物柜（演示）', '', '演示用机型：小型立式柜体，单门绕竖轴开启。用于演示窄通道里的单门净空与转角摆放。', '合成演示数据', '演示设定 · 非产品尺寸', 'single', '#418994', '', 'active', '{"id":"demo-freezer-upright","name":"单门储物柜（演示）","modelCode":"DEMO-FZ-25U","w":700,"d":690,"h":1000,"color":"#418994","origin":"合成演示数据","sizeNote":"演示设定 · 非产品尺寸","desc":"演示用机型：小型立式柜体，单门绕竖轴开启。用于演示窄通道里的单门净空与转角摆放。","facts":[["外形","立式，单门"],["内部结构","示意空腔"]],"features":[["开门方式","单门，绕竖轴开启，开门方向可切换。"],["摆放","体积小，适合演示密集摆位与通道判据。"]],"sourceUrl":null,"recipeId":"demo-freezer-upright","assetId":null,"doors":[{"node":"single_door","axis":"y","openAngleRad":1.85,"openAngleDeg":106,"hinge":{"x":0.30222,"y":0.41032,"z":0.2709},"leaf":{"x0":-0.31281,"x1":0.30575,"z0":0.2656,"z1":0.34502},"swing":0.61948,"pivot":[0.338,0.475,0.353]}],"doorVerified":false}', 2),
  ('DEMO-FZ-25C', '顶开料箱（演示）', '', '演示用机型：卧式料箱，上盖绕水平轴翻开。用于演示顶开门型与「上方净空」判据。', '合成演示数据', '演示设定 · 非产品尺寸', 'top', '#607fac', '', 'active', '{"id":"demo-freezer-chest","name":"顶开料箱（演示）","modelCode":"DEMO-FZ-25C","w":1320,"d":656,"h":800,"color":"#607fac","origin":"合成演示数据","sizeNote":"演示设定 · 非产品尺寸","desc":"演示用机型：卧式料箱，上盖绕水平轴翻开。用于演示顶开门型与「上方净空」判据。","facts":[["外形","卧式，上盖"],["内部结构","示意空腔"]],"features":[["开门方式","上盖绕水平轴翻开，开启角约 -89°。"],["上方净空","顶开设备要留上方空间 —— 与侧开门不是同一条判据。"]],"sourceUrl":null,"recipeId":"demo-freezer-chest","assetId":null,"doors":[{"node":"top_lid","axis":"x","openAngleRad":-1.55,"openAngleDeg":-88.81,"hinge":{"x":0,"y":0.6831,"z":-0.32354},"leaf":{"x0":-0.61813,"x1":0.61813,"z0":-0.328,"z1":0.328},"swing":0.65438,"pivot":[0,0.92,-0.41]}],"doorVerified":false}', 3),
  ('DEMO-CB-800', '立式机柜（演示）', '', '演示用机型：单门外开的立式机柜，随仓库不带 3D 模型。它是门净空、贴墙摆放与自动摆位这几组判据的演示载体（门几何为演示设定，不是实测值）。', '合成演示数据', '演示设定 · 非产品尺寸', 'single', '#3c6f9e', '', 'active', '{"id":"demo-cabinet-800","name":"立式机柜（演示）","modelCode":"DEMO-CB-800","w":1151.92501,"d":1094.83496,"h":1986.69948,"color":"#3c6f9e","origin":"合成演示数据","sizeNote":"演示设定 · 非产品尺寸","desc":"演示用机型：单门外开的立式机柜，随仓库不带 3D 模型。它是门净空、贴墙摆放与自动摆位这几组判据的演示载体（门几何为演示设定，不是实测值）。","facts":[["外形","立式，单门外开"],["门几何","演示设定：开启角 106°，门叶宽约 1.15 m"]],"features":[["开门方式","单门绕竖轴开启（axis=y），开门方向可切换。"],["判据载体","门净空 ok/warn/bad 三档、贴墙摆放、自动摆位都拿它当输入。"]],"sourceUrl":null,"recipeId":"demo-cabinet-800","assetId":null,"doors":[{"node":"outer_door","axis":"y","openAngleRad":1.85,"openAngleDeg":106,"hinge":{"x":0.56298,"y":1.22,"z":0.42566},"leaf":{"x0":-0.57596,"x1":0.57193,"z0":0.29557,"z1":0.54742},"swing":1.14635,"pivot":[0.56298,1.22,0.42566]}],"doorVerified":false}', 4),
  ('DEMO-BL-100', '样品搅拌机（演示）', '', '演示用机型：唯一随仓库发布 3D 模型的机型。声明包络与实测包围盒逐轴相等（1:1），门是模型里量出来的真铰链门（door_single，绕竖轴 106°）。用于演示三维载入、门开合与门净空判据。', '演示模型', '演示模型 · 尺寸来自模型实测', 'single', '#2f7f8f', '', 'active', '{"id":"demo-blender","name":"样品搅拌机（演示）","modelCode":"DEMO-BL-100","w":676,"d":672,"h":1310.5,"color":"#2f7f8f","origin":"演示模型","sizeNote":"演示模型 · 尺寸来自模型实测","desc":"演示用机型：唯一随仓库发布 3D 模型的机型。声明包络与实测包围盒逐轴相等（1:1），门是模型里量出来的真铰链门（door_single，绕竖轴 106°）。用于演示三维载入、门开合与门净空判据。","facts":[["模型精度","约 7.7 万三角面"],["载入方式","单级 LOD（lod0）"],["门","实测单门，扫掠半径 558 mm"]],"features":[["尺寸口径","676 × 672 × 1310.5 mm 为模型实测包围盒，同时作为声明包络。"],["门与开合","门几何由 tools/models/verify-models.py 从 GLB 里量出来（铰链轴 = 门节点原点），不是估的。"],["用途","演示三维载入、门开合与门净空判据。"]],"sourceUrl":null,"recipeId":null,"assetId":"demo-blender-001","doors":[{"node":"door_single","axis":"y","openAngleRad":1.85}],"doorVerified":false}', 5)
ON DUPLICATE KEY UPDATE `name`=VALUES(`name`), `series`=VALUES(`series`), `description`=VALUES(`description`),
  `origin`=VALUES(`origin`), `size_note`=VALUES(`size_note`), `door_part`=VALUES(`door_part`), `color`=VALUES(`color`),
  `source_url`=VALUES(`source_url`), `status`=VALUES(`status`), `recipe_json`=VALUES(`recipe_json`), `sort_order`=VALUES(`sort_order`);

-- ② 说明条目（facts/features）：按产品整体替换 —— 目录里删掉的条目必须在库里真消失
DELETE FROM `product_note` WHERE `product_id` IN (
  (SELECT `id` FROM `product` WHERE `model_no`='DEMO-CT-100'),
  (SELECT `id` FROM `product` WHERE `model_no`='DEMO-FZ-040'),
  (SELECT `id` FROM `product` WHERE `model_no`='DEMO-FZ-25U'),
  (SELECT `id` FROM `product` WHERE `model_no`='DEMO-FZ-25C'),
  (SELECT `id` FROM `product` WHERE `model_no`='DEMO-CB-800'),
  (SELECT `id` FROM `product` WHERE `model_no`='DEMO-BL-100'));
INSERT INTO `product_note` (`product_id`, `kind`, `label`, `value`, `sort_order`) VALUES
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-CT-100'), 'fact', '外形', '立式，矩形包络', 0),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-CT-100'), 'fact', '三维模型', '无（只声明包络）', 1),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-FZ-040'), 'fact', '有效容积', '510 L（演示值）', 0),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-FZ-040'), 'fact', '箱内温度', '-20～-40℃（演示值）', 1),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-FZ-040'), 'fact', '电压/频率', '220V / 50Hz（演示值）', 2),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-FZ-25U'), 'fact', '外形', '立式，单门', 0),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-FZ-25U'), 'fact', '内部结构', '示意空腔', 1),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-FZ-25C'), 'fact', '外形', '卧式，上盖', 0),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-FZ-25C'), 'fact', '内部结构', '示意空腔', 1),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-CB-800'), 'fact', '外形', '立式，单门外开', 0),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-CB-800'), 'fact', '门几何', '演示设定：开启角 106°，门叶宽约 1.15 m', 1),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-BL-100'), 'fact', '模型精度', '约 7.7 万三角面', 0),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-BL-100'), 'fact', '载入方式', '单级 LOD（lod0）', 1),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-BL-100'), 'fact', '门', '实测单门，扫掠半径 558 mm', 2),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-CT-100'), 'feature', '尺寸口径', '3045 × 2470 × 2138 mm 是演示设定，不是实测值，也不对应任何真实设备。', 0),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-CT-100'), 'feature', '三维视图', '没有随仓库发布的模型，切到三维是空的 —— 这是刻意保留的路径。', 1),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-CT-100'), 'feature', '用途', '演示占地与通道判据，不代表任何真实设备的规格。', 2),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-FZ-040'), 'feature', '独立双控', '上下门独立开合 —— 演示用文案。', 0),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-FZ-040'), 'feature', '存储结构', '内部层板的示意配置。', 1),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-FZ-040'), 'feature', '开门方式', '对开双门，绕竖轴开启。', 2),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-FZ-25U'), 'feature', '开门方式', '单门，绕竖轴开启，开门方向可切换。', 0),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-FZ-25U'), 'feature', '摆放', '体积小，适合演示密集摆位与通道判据。', 1),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-FZ-25C'), 'feature', '开门方式', '上盖绕水平轴翻开，开启角约 -89°。', 0),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-FZ-25C'), 'feature', '上方净空', '顶开设备要留上方空间 —— 与侧开门不是同一条判据。', 1),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-CB-800'), 'feature', '开门方式', '单门绕竖轴开启（axis=y），开门方向可切换。', 0),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-CB-800'), 'feature', '判据载体', '门净空 ok/warn/bad 三档、贴墙摆放、自动摆位都拿它当输入。', 1),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-BL-100'), 'feature', '尺寸口径', '676 × 672 × 1310.5 mm 为模型实测包围盒，同时作为声明包络。', 0),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-BL-100'), 'feature', '门与开合', '门几何由 tools/models/verify-models.py 从 GLB 里量出来（铰链轴 = 门节点原点），不是估的。', 1),
  ((SELECT `id` FROM `product` WHERE `model_no`='DEMO-BL-100'), 'feature', '用途', '演示三维载入、门开合与门净空判据。', 2);
