# dsh-pet-3d

DSH 的 3D 桌宠插件：`three.js`/glTF 渲染器 + 6 状态动作编排 + **插件自己的应用内设置页**（设置 → 3D 桌宠）
+ 藏在开发者模式里的检查面板（放大/环绕/逐条试播/强制相位/编排器）。

- **宿主半边**：模型目录扫描（`$DSH_HOME/models/<id>/`）、相位状态机、`/api/pet3d/*` JSON 接口、`/pet3d/<id>/*` 媒体路由。
- **浏览器半边**：`lib/client.js`（DSH 的 `__ModuleLoader__` 形态），按需加载 `lib/three-vendor.js`；
  它同时注册 `settings.section` 一级设置页。
- **模型是数据，不是代码**：插件只带代码（约 1.5 MB），模型放在 `$DSH_HOME/models/<id>/`，换模型不用重装插件。

## 安装

### 方式一：从 npm（最省事）

```sh
dsh plugin --profile web add dsh-pet-3d
```

桌面客户端（DSH Desktop）的应用自有 profile 不接受 CLI 写入，请在 GUI 里装：
**设置 → 插件 → 安装**，填 npm 包名 `dsh-pet-3d`。

### 方式二：从本地目录（开发/自用）

GUI 的插件页接 `link:` 这类 spec（官方安装器与 `dsh plugin add` 同一套词汇）：

```
link:<仓库>/packages/dsh-pet-3d
```

或打成 tarball 再装：

```sh
pnpm pack           # 产出 dsh-pet-3d-1.0.4.tgz
# GUI 里填： file:<仓库>/packages/dsh-pet-3d/dsh-pet-3d-1.0.4.tgz
```

> `link:` 安装现在是**可用**的：宿主半边已把 schemastery 打进 `lib/index.js`，
> 导入器自带 `tools/vendor/three-node.mjs`（three + 容错 FBXLoader + GLTFExporter），
> 不再依赖 profile 里装任何 npm 包。发布/分享仍然推荐 **tarball**（安装器行为更标准）。

插件自带的 `cordis.patch.yml`（`dsh.bundle.patch`）会在安装时被合并，插入一条
`id: pet3d` 的插件行 —— **不需要手工改 profile 的 `cordis.patch.yml`**。
手工再加一条会得到两条重复行（`mountOnce` 会兜住，但配置看起来是坏的）。

> ⚠️ 从**手工安装**升级到插件系统安装之前，先把手工那份拆掉：删掉 profile
> `cordis.patch.yml` 里手工加的 `- id: pet3d` 那段 insert，再删掉
> `profiles/<profile>/node_modules/dsh-pet-3d/`。否则安装器会看到重复的入口 id 并把新包回滚
> （它不会去动已有插件 —— 这是有意的保护）。

### 装完之后

1. **重启 DSH**（宿主半边 = `lib/index.js` 只在启动时加载；浏览器半边热生效）。
2. 桌面上出现宠物。日常用不上任何面板：宠物只负责拖位置。
3. 要调它的显示、换模型、重新导入：**设置 → 3D 桌宠**（插件自己的一级设置页，见下）。
4. 要调动作（试播 161 条、强制相位、放大环绕、编排器、仪表）：在同一页的
   **开发者** 分区打开「开发者模式」，然后点宠物 → 小方块 → 动作面板。

## 模型

模型目录契约（`$DSH_HOME` 默认 `%USERPROFILE%\.dsh`；DSH Desktop 下通常由应用自己指定）：

```
$DSH_HOME/models/<id>/
  .import/model.glb          # 全保留网格 + 骨骼
  .import/clips.json         # 动作清单
  .import/clips.bin          # float32 拼好的 times/values
  .import/import.json        # 溯源 + 自证结果
  choreography.json          # 每个相位状态演哪几段（可选，缺省=内置缺省）
```

- 把导入好的模型目录整个拷进 `$DSH_HOME/models/` 就是安装（`models/` 下不会被扫描的目录：
  `_` 开头与 `.` 开头的）。
- 自带导入器：从源 FBX 生成上面四个文件

  ```sh
  node <插件目录>/tools/pet3d-import.mjs <model-dir> --json
  ```

  需要 `three`（本包已作为依赖装上）。导入是独立进程，导入器坏了不用重启宿主 —— 面板「重载」
  会重新扫目录。

## 配置（设置 → 3D 桌宠）

插件在 DSH 的设置对话框里有一页自己的设置（客户端注册 `settings.section`，id `pet3d`）。
四个分区，改完即时生效，不需要重启、不需要刷新：

| 分区 | 内容 | 写到哪里 |
|---|---|---|
| **显示** | 显示宠物 / 大小 / 右边距 / 下边距 | `POST /api/pet3d/display` → `$DSH_HOME/pet3d.json`（和拖动宠物同一条路） |
| **模型** | 选模型、重新导入（reimport + 热换）、导入阻塞原因、目录问题、导入器脚本 | `/set-pet`、`/reimport`；脚本路径写 cordis Config 的 `importerScript` |
| **插件** | 总开关 `enabled` | cordis Config（`configForms` 的 mutate，宿主写 profile 配置） |
| **开发者** | 开发者模式开关 | 浏览器 `localStorage.dshPet3dDebug`（纯客户端 UI 偏好，见下） |

cordis Config 的字段仍然是这台宿主上的"声明层"，profile 的 `cordis.patch.yml` 可以钉住初始外观：

| 字段 | 缺省 | 作用 |
|---|---|---|
| `enabled` | `true` | 总开关（关掉后 `/api/pet3d/*` 路由消失） |
| `visible` | `true` | 桌面是否显示宠物 |
| `size` | `348` | 渲染方框边长，px |
| `right` / `bottom` | `20` / `20` | 距视口右边/下边，px |
| `petId` | 空 | 选中的模型 id（留空=自动第一个） |
| `importerScript` | 空 | 覆盖导入器脚本的绝对路径（留空=用包内 `tools/pet3d-import.mjs`） |

> 显示三项有两条来源：`$DSH_HOME/pet3d.json`（用户拖出来的实际值，优先）和上面的 Config
> （初始声明）。设置页读写的是前者 —— 也就是"你眼前看到的那个位置"，所以拖动和输入框永远是同一个数。

## 动作系统

- 6 状态：`idle` / `walk` / `run` / `think` / `done` / `failed`。宿主相位映射：
  `thinking|tool|review → run`、`waiting → think`、`done → done`、`failed → failed`；
  `walk` 只由客户端在「闲置收到 run」时补一段引导。
- 每个状态三段：`enter`（起手）→ `loop`（循环，有限或无限）→ `exit`（收招）。
- 17 条过渡桥 `transitions["从>到"]`，桥必须完整（缺一支整条作废）。
- 交叉淡入淡出 220 ms；同一时刻只允许一条动作在驱动骨架。

### 加载体验

模型从"上屏"到"第一次摆好姿势"之间，画面上是 **T-pose**。这段时间插件会用一块近全黑的
圆角遮罩（转圈 + `正在加载模型…`，`data-pet3d-loading`）把它盖住，等**有动作真的在驱动骨架**
（权重过半）再淡出 —— 所以用户不会看到 T-pose。遮罩 `pointerEvents: none`，点击照常穿透；
加载失败时会自动撤掉，免得把错误提示挡住；热换模型时会重新盖上。

`choreography.json` 手改之后：

```sh
node <仓库>/tools/check-pet3d-choreography.mjs   # 校验 clip 名存在 + 桥完整 + 演出能解析
```

## 演出编排（`performances`）

`states` 回答的是"**某个相位循环演什么**"（一直演到相位变）；演出回答的是
"**某个时刻按顺序演一小段**"（有开头有结尾，演完回到当前相位）。两件事正交，可以叠加。

```json
"performances": {
  "celebrate": {
    "name": "完工庆祝",
    "trigger": "done",
    "steps": [
      { "clip": "Galgame_Happy_Start" },
      { "clip": "Galgame_Happy_Loop", "seconds": 2 },
      { "clip": "Galgame_Happy_End", "rate": 0.8 }
    ]
  }
}
```

- `steps`：按顺序连播。每步 `clip`（**允许短名与通配**，和 `states` 的写法一致）、
  可选 `seconds`（这一步占多少秒；**不填就播到这条 clip 的自然结尾**）、可选 `rate`（0.1–4）。
- `trigger`：`manual`（只手动试播）/ `run`（开始干活）/ `done`（回合完成）/
  `failed`（出错）/ `idle`（闲置够久）/ `daily`（每天第一次打开）。
- `once`：每个触发窗口只演一次（缺省 true）。
- `afterSeconds`：仅 `idle` 用，闲置多少秒后开演（缺省 180）。
- **演出的硬约束和"一拍"一样**：同一时刻只允许一条动作、220ms 交叉淡入淡出、演出期间
  相位变化被屏蔽（记在 `lastState` 里，演完再回），演完回当前相位而不是停在最后一步。

编排入口：**设置 → 3D 桌宠 → 演出**。时间线按 `clips.json` 里的真实时长画块（块宽 ∝ 秒数），
可以增删步、`↑↓` 调顺序、单步限时、倍率、单步试播、整段试播、停下；「加入默认四套」给你
`见面(SwitchIn_Normal)` / `完工庆祝` / `开始干活(TurnBack)` / `闲置小动作` 四套现成的改。

> ⚠️ **保存演出需要宿主那一半也认识它**：`performances` 的解析在 `lib/index.js` 里。
> 如果宿主还没重启，保存会被旧解析器吃掉 —— 编排器会**当场读回文件并明确告诉你**
> （"保存没生效：宿主这一版还不认识「演出」"），而不是假装成功。原文件同时留
> `choreography.json.bak`。重启 DSH 后再保存一次即可。

验收：

```sh
node tools/verify-pet-menu.mjs --wait 25    # 悬浮菜单 + 互动（真实页面，点按 + 仪表 + 刷新持久化）
node tools/verify-live-window.mjs           # 活体：宠物真的挂载到页面、WebGL 真的在画
```

## 开发者模式（检查面板 + 仪表）

检查面板是给"调动作"的人用的，不属于日常操作：**关着的时候宠物身上什么都不出现**
（点它不会有小方块，也没有编排器入口），只剩拖动。

打开方式：**设置 → 3D 桌宠 → 开发者 → 开发者模式**。打开后点宠物出现小方块，点小方块展开面板。

开关存在浏览器 `localStorage.dshPet3dDebug`（值 `'1'`），因为它纯属**界面偏好**、
而且点宠物那一刻就要同步判定（等一次配置往返太慢）。它同时也是渲染器仪表的开关：
打开后宠物右下角会出现一行绿色实时仪表。

```js
localStorage.dshPet3dDebug = '1'   // 等价于在设置页里打开开发者模式（然后刷新页面）
```

仪表里的 `acts=` 字段形如 `Ani_Walk_Loop:0.99@0.22s`：名字:权重@淡入淡出窗口宽度。
稳态应当是 1 条；出现 2 条以上且持续时间远超 0.22 s，就是"两套动作在打架"；
`acts=0!` 表示骨架此刻没有被任何动作驱动（会定格）。

验收（无头 Chrome，需要本机 GUI 在跑）：

```sh
node tools/verify-pet-menu.mjs --wait 25    # 悬浮菜单 + 互动（点按 + 仪表 + 刷新持久化）
node tools/verify-live-window.mjs           # 活体：宠物真的挂载到页面、WebGL 真的在画
node tools/check-pet3d*.mjs                 # 8 个离线守卫（不需要 GUI）
```

## 已知限制

- **模型不进包**：动作资产动辄数百 MB，只能随模型目录分发。
- 27 条特效 clip 是 0 轨道空壳（161 条里实际可播 134 条）。
- `gap: "pause"` 已实现但客户端只接了 `stretch`；`remainingMs`（"模型还要想多久"）宿主不提供，
  所以走「循环直到相位变化」的兜底。

## 许可

Apache-2.0。
