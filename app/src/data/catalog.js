/**
 * 型号目录（本地兜底数据）
 *
 * 这是**后端没起时的兜底目录**：正常路径是 `GET /api/catalog`（库里的真目录），
 * 取不到才退回这份静态数据（见 `src/catalog.js`）。两份的形状必须一致，
 * 否则"后端没起能干活、后端起来反而少字段"这类偏差会很难查。
 *
 * 内容是**合成演示数据**：6 款演示设备，只有 `demo-blender` 带 3D 模型
 * （`assets/optimized/demo-blender-001.lod0.glb`，门是从模型里量出来的真铰链门）；
 * `demo-ct-scanner` 刻意**没有**模型 —— 用来演示「只有声明包络、三维视图为空」那条路径。
 * 数值是演示设定，不对应任何真实设备。
 *
 * 口径提醒：
 *   w/d/h = **声明包络**（做 2D 占地用，不含把手凸出），单位米
 *   sizeNote = 尺寸可信度（"演示模型 · 尺寸来自模型实测" / "演示设定 · 非产品尺寸"）
 *   这两条必须原样显示给用户 —— 把演示尺寸当成厂家规格是最容易犯的错。
 */

export const CATALOG = [
  {
    id: 'demo-ct-scanner',
    name: 'CT 扫描仪（演示）',
    model: 'DEMO-CT-100',
    w: 3.045,
    d: 2.47,
    h: 2.138,
    color: '#187fb0',
    origin: '合成演示数据',
    sizeNote: '演示设定 · 非产品尺寸',
    noteLevel: 'bad',
    desc: '演示用机型：一台占地较大的设备，用于演示占地判据、贴墙摆放与通道宽度。它**不随仓库发布 3D 模型**，三维视图为空 —— 这正是「只有声明、没有模型」那条路径的样子。尺寸为演示设定。',
    facts: [
      ['外形', '立式，矩形包络'],
      ['三维模型', '无（只声明包络）'],
    ],
    features: [
      ['尺寸口径', '3045 × 2470 × 2138 mm 是演示设定，不是实测值，也不对应任何真实设备。'],
      ['三维视图', '没有随仓库发布的模型，切到三维是空的 —— 这是刻意保留的路径，不是故障。'],
      ['用途', '演示占地与通道判据，不代表任何真实设备的规格。'],
    ],
    hinges: [],
    doorPart: null,
    asset: { kind: 'recipe', note: '无随仓库发布的模型，仅声明包络' },
  },
  {
    id: 'demo-freezer-dual',
    name: '双温低温保存箱（演示）',
    model: 'DEMO-FZ-040',
    w: 0.99,
    d: 0.8712,
    h: 1.98,
    color: '#286eac',
    origin: '合成演示数据',
    sizeNote: '演示设定 · 非产品尺寸',
    noteLevel: 'bad',
    recipeId: 'demo-freezer-dual',
    desc: '演示用机型：上下双门、独立双温区的立式箱体。用于演示对开门、门净空与并排摆放的判据；尺寸与参数均为演示设定。',
    facts: [
      ['有效容积', '510 L（演示值）'],
      ['箱内温度', '-20～-40℃（演示值）'],
      ['电压/频率', '220V / 50Hz（演示值）'],
    ],
    features: [
      ['独立双控', '上下箱体独立控温 —— 演示用文案。'],
      ['存储结构', '上 6 下 4 个抽屉的示意配置。'],
      ['开门方式', '对开双门，绕竖轴开启。'],
    ],
    doorPart: 'double',
    asset: { kind: 'recipe', note: '无随仓库发布的模型，仅声明门与包络' },
  },
  {
    id: 'demo-freezer-upright',
    name: '立式低温保存箱（演示）',
    model: 'DEMO-FZ-25U',
    w: 0.7,
    d: 0.69,
    h: 1,
    color: '#418994',
    origin: '合成演示数据',
    sizeNote: '演示设定 · 非产品尺寸',
    noteLevel: 'bad',
    recipeId: 'demo-freezer-upright',
    desc: '演示用机型：小型立式箱体，单门绕竖轴开启。用于演示窄通道里的单门净空与转角摆放。',
    facts: [
      ['外形', '立式，单门'],
      ['内部结构', '示意空腔'],
    ],
    features: [
      ['开门方式', '单门，绕竖轴开启，开门方向可切换。'],
      ['摆放', '体积小，适合演示密集摆位与通道判据。'],
    ],
    doorPart: 'single',
    asset: { kind: 'recipe', note: '无随仓库发布的模型，仅声明门与包络' },
  },
  {
    id: 'demo-freezer-chest',
    name: '卧式低温保存箱（演示）',
    model: 'DEMO-FZ-25C',
    w: 1.32,
    d: 0.656,
    h: 0.8,
    color: '#607fac',
    origin: '合成演示数据',
    sizeNote: '演示设定 · 非产品尺寸',
    noteLevel: 'bad',
    recipeId: 'demo-freezer-chest',
    desc: '演示用机型：卧式箱体，上盖绕水平轴翻开。用于演示顶开门型与"上方净空"判据。',
    facts: [
      ['外形', '卧式，上盖'],
      ['内部结构', '示意空腔'],
    ],
    features: [
      ['开门方式', '上盖绕水平轴翻开，开启角约 -89°。'],
      ['上方净空', '顶开设备要留上方空间 —— 与侧开门不是同一条判据。'],
    ],
    doorPart: 'top',
    asset: { kind: 'recipe', note: '无随仓库发布的模型，仅声明门与包络' },
  },
  {
    id: 'demo-cabinet-800',
    name: '立式保存箱（演示）',
    model: 'DEMO-CB-800',
    w: 1.15192501,
    d: 1.09483496,
    h: 1.98669948,
    color: '#3c6f9e',
    origin: '合成演示数据',
    sizeNote: '演示设定 · 非产品尺寸',
    noteLevel: 'bad',
    recipeId: 'demo-cabinet-800',
    desc: '演示用机型：单门外开的立式箱体，随仓库不带 3D 模型。它是门净空、贴墙摆放与自动摆位这几组判据的演示载体（门几何为演示设定，不是实测值）。',
    facts: [
      ['外形', '立式，单门外开'],
      ['门几何', '演示设定：开启角 106°，门叶宽约 1.15 m'],
    ],
    features: [
      ['开门方式', '单门绕竖轴开启（axis=y），开门方向可切换。'],
      ['判据载体', '门净空 ok/warn/bad 三档、贴墙摆放、自动摆位都拿它当输入。'],
    ],
    hinges: [
      { node: 'outer_door', axis: 'y', openAngleDeg: 106 },
    ],
    doorPart: 'single',
    asset: { kind: 'recipe', note: '无随仓库发布的模型，仅声明门与包络' },
  },
  {
    id: 'demo-blender',
    name: '样品搅拌机（演示）',
    model: 'DEMO-BL-100',
    w: 0.676,
    d: 0.672,
    h: 1.3105,
    color: '#2f7f8f',
    origin: '演示模型',
    sizeNote: '演示模型 · 尺寸来自模型实测',
    noteLevel: 'warn',
    desc: '演示用机型：**唯一随仓库发布 3D 模型**的机型（assets/optimized/demo-blender-001.lod0.glb）。声明包络与实测包围盒逐轴相等（1:1），门是模型里量出来的真铰链门（door_single，绕竖轴 106°）。',
    facts: [
      ['模型精度', '约 7.7 万三角面'],
      ['载入方式', '单级 LOD（lod0）'],
      ['门', '实测单门，扫掠半径 558 mm'],
    ],
    features: [
      ['尺寸口径', '676 × 672 × 1310.5 mm 为模型实测包围盒，同时作为声明包络。'],
      ['门与开合', '门几何由验模工具从 GLB 里量出来（铰链轴 = 门节点原点），不是估的。'],
      ['用途', '演示三维载入、门开合与门净空判据。'],
    ],
    hinges: [
      { node: 'door_single', axis: 'y', openAngleDeg: 106 },
    ],
    doorPart: 'single',
    asset: { kind: 'demo-glb', note: '演示模型，随仓库发布' },
  },
];
