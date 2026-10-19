# panyinhu-placeholder（合成占位模型）

这是一个**合成占位宠物**，**不是**任何游戏资产，也不包含任何第三方角色模型或贴图。

它由 `tools/make-fixture-model.mjs` 生成：一个蒙皮小网格、两段动画
（`Fixture_Arm_Idle_Loop` / `Fixture_Galgame_Sad`）和一张 1×1 贴图，
整个目录约 2 KB。用途是让任何人 clone 仓库后**立刻能跑起来**：

```powershell
# 把仓库里的模型目录复制到 DSH 的模型目录
node tools/install-models.mjs
```

装完后 DSH 的模型列表里会出现 `panyinhu-placeholder`，宠物是一个几何小方块，
动作 / 互动 / 悬浮菜单都能用——足够验证插件链路，不涉及任何版权素材。

> 目录名沿用历史命名。它只是个占位符，换成你自己的模型后可以直接改名。

## 换成你自己的模型

1. 按 `packages/dsh-pet-3d/README.md` 的「模型」一节准备模型目录
   （`.import/model.glb`、`clips.json`、`clips.bin`、`textures/`、`options.json`）；
2. 放到 `$DSH_HOME/models/<你的 id>/`；
3. `options.json` 的 `phase` 映射到 `clips.json` 里真实存在的动作名；
4. 可选：`appearance.json`（配饰 / 款式）、`interactions.json`（互动）、
   `choreography.json`（相位编排）。

插件不关心模型是谁，只读目录。本仓库只带这个合成占位模型。

## 许可

本目录的几何 / 动画 / 贴图由仓库脚本生成，跟仓库代码一样按 Apache-2.0 提供。
