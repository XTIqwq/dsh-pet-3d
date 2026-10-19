# DSH 3D 桌宠（dsh-pet-3d）

> 一个 DSH（DeepSeek Harness）Web GUI 插件：把 3D 模型放进页面角落当桌宠，
> 按会话状态演动作，鼠标移上去可以换装、戴配饰、互动。

- **版本**：v1.0.3（零运行时依赖）
- **许可**：Apache-2.0，见 [`LICENSE`](LICENSE)；fork 自 `@linxin666/dsh-pet`，见 [`NOTICE`](NOTICE)
- **第三方组件**：见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)
- **不含任何游戏模型 / 贴图 / 美术资产**：仓库只带一个约 2 KB 的合成占位模型

## 这是什么

把一只 3D 模型放在页面角落里，按会话状态（闲置 / 走 / 跑 / 思考 / 完成 / 出错）演动作；
鼠标移上去点小熊，可以穿脱配饰、摸摸 / 招呼 / 转圈 / 喂食。

模型是**数据**（`$DSH_HOME/models/<id>/`），插件本身只带代码。换模型不用改代码、不用重启。

## 怎么装

```powershell
# 1) 构建 + 打包（在仓库根）
pnpm install
pnpm -C packages/dsh-pet-3d build     # 产物在 packages/dsh-pet-3d/lib/
pnpm -C packages/dsh-pet-3d pack      # 得到 dsh-pet-3d-1.0.3.tgz

# 2) 安装到 profile —— 先确认是哪个 profile
#    Desktop 一般是 desktop；`dsh web` 用的是 web。装错 profile 等于没装。
pnpm --dir "$env:USERPROFILE\.dsh\profiles\desktop" add `
  "packages/dsh-pet-3d/dsh-pet-3d-1.0.3.tgz"
```

装完**重启 DSH**（宿主半边在启动时加载；浏览器半边刷新页面即可）。插件自带的
`cordis.patch.yml` 会插入 `pet3d` 那一行，**不要手工再加**（会得到两条重复行）。

> v1.0.3 起 `link:` 安装也能跑（`lib/index.js` 自带 schemastery、导入器自带 three），
> 但正式分享仍建议用 tgz。

## 怎么用

| 入口 | 做什么 |
|---|---|
| 鼠标移进宠物方框 → 点正中间 🐻 | 悬浮菜单：「配饰」逐件穿脱、「互动」（摸摸 / 招呼 / 转圈 / 喂食 + 好感度）；「整套外观 / 款式」有对应数据时自动出现 |
| 拖动宠物 | 移动位置（位置会记住） |
| 设置 → 3D 桌宠 | 大小、位置、选模型、重新导入、开发者模式 |
| 开发者模式 + 点宠物 | 检查面板（动作试播 / 相位 / 视角 / 编排器 / 仪表） |

互动数据在模型目录的 `interactions.json`；台词、动作、好感度上限都能改，**2 秒内生效**，不用刷新。

## 目录说明

| 路径 | 内容 |
|---|---|
| `packages/dsh-pet-3d/` | 插件本体（`src/` 源码 + `package.json`；`lib/` 由构建生成，不入库） |
| `tools/` | 导入器、离线守卫、活体验收与安装脚本 |
| `docs/` | 设计 / 排障文档（索引见 [`docs/README.md`](docs/README.md)） |
| `models/panyinhu-placeholder/` | 仓库自带的合成占位模型（约 2 KB，Apache-2.0，clone 即可跑） |
| `shared/` | 两个包共用的 tsdown 打包配置 |
| `$DSH_HOME/models/` | 使用者自己的模型数据（真实模型**不进版本库**） |

## 模型与首次运行

仓库**不含**任何游戏 / 角色模型。自带的是 `models/panyinhu-placeholder/`：一个由
`tools/make-fixture-model.mjs` 生成的合成占位宠物（一个蒙皮小网格 + 两段动画），
用来让任何人 clone 后立刻跑通插件：

```powershell
node tools/install-models.mjs   # 复制到 $DSH_HOME/models/
```

要用自己的模型，把目录放到 `$DSH_HOME/models/<id>/`（`options.json` 的 `phase` 要指向
`clips.json` 里真实存在的动作名；可选 `appearance.json` / `interactions.json` /
`choreography.json`）。插件只扫描这个目录，不需要改代码。

## 验证

```powershell
node tools/check-pet3d*.mjs                 # 8 个离线守卫（不需要 GUI）
node tools/check-appearance.mjs             # 配饰表与模型节点是否对得上
node tools/verify-pet-menu.mjs --wait 25    # 悬浮菜单 + 互动（真实页面，点按 + 仪表 + 刷新持久化）
node tools/verify-live-window.mjs           # 活体：宠物真的挂载到页面、WebGL 真的在画
```

## 已知限制

1. **模型不进包**：动作资产动辄数百 MB，只能随模型目录分发。
2. **特效 clip 多为空壳**：带特效轨道的 clip 里有一部分是 0 轨道占位，导入时会被识别，
   播放时表现为「动作有名字但画面不动」。
3. **模型 UV 口径随来源而变**：不同来源导出的模型 V 轴约定不一致，导入时需要按实际
   情况选择是否翻转；导错了表现为贴图整片错位（看起来像贴图损坏，其实是 UV）。

> 已知**缺陷**（自动重导入不退避、复制分发的模型恒判 stale 等）单独记录在
> [`docs/已知问题.md`](docs/已知问题.md)。

## 更多

- 变更记录：[`CHANGELOG.md`](CHANGELOG.md)
- 给 agent 的部署契约：[`AGENTS.md`](AGENTS.md)
- 文档索引：[`docs/README.md`](docs/README.md)

## 鸣谢

### 上游

`dsh-pet-3d` 是 **`@linxin666/dsh-pet`** 的独立 fork，以 Apache-2.0 授权。

上游作者提供了整个插件的骨架：可插拔渲染器抽象、宠物注册表、设置页体系、
相位状态机与资源路由。本项目在其上新增 `model3d` 渲染器、悬浮菜单、
动作编排与导入流水线——**没有上游那套设计，这个插件不会存在**。

上游仓库：<https://github.com/zhu1090093659/dsh-pet>
（原 `@linxin666/dsh-pet` 包，fork 基线 v0.4.4）

完整的修改清单见 [`NOTICE`](NOTICE)。

### 依赖与工具

本项目的渲染与导入能力建立在以下开源工作上：

- **[three.js](https://threejs.org/)**（MIT）— WebGL 渲染与模型加载的全部基础
- **[@pixiv/three-vrm](https://github.com/pixiv/three-vrm)**（MIT）— VRM 模型支持
- **[@deepseek-ai/schemastery](https://www.npmjs.com/package/@deepseek-ai/schemastery)**（MIT）— 配置 schema
- **[tsdown](https://tsdown.dev/) / [rolldown](https://rolldown.rs/)**（MIT）— 打包
- **[react](https://react.dev/)**（MIT）— 界面层

### 上游曾收录的素材作者

以下创作者的作品曾随上游包分发（本项目已不再包含，仅作署名）：

- **Pessimist0906** — OUO Neko 宠物素材（MIT）
- **stushansusu（涂山苏苏）** — 相关宠物素材（MIT）
- **DeepSeek** — whale 装饰素材（MIT）

### 特别感谢

- **DeepSeek Harness 团队** —— 提供了这套插件系统与完整的宿主 API，
  以及 `AGENTS.md` 所依赖的部署契约机制。

---

## 许可

代码以 **Apache-2.0** 发布，全文见 [`LICENSE`](LICENSE)。
fork 关系与修改声明见 [`NOTICE`](NOTICE)，第三方组件见
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)，作者信息见 [`AUTHORS.md`](AUTHORS.md)。
