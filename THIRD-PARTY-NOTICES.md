# Third-party notices

本仓库代码以 Apache-2.0 发布（见 `LICENSE`），并包含/依赖以下第三方组件。
各组件版权归其作者所有，按其各自许可证使用。

## 随包分发（会被打进 tarball）

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| [`three`](https://threejs.org/) | 0.186.1（浏览器）/ 0.171.0（导入器 bundle） | MIT | WebGL 渲染与模型导入；`lib/three-vendor.js`、`tools/vendor/three-node.mjs` |
| [`@pixiv/three-vrm`](https://github.com/pixiv/three-vrm) | 3.5.x | MIT | VRM 支持，打进 three vendor bundle |
| [`@deepseek-ai/schemastery`](https://www.npmjs.com/package/@deepseek-ai/schemastery) | 3.18.x | MIT | 配置 schema，已内联进 `lib/index.js` |

> 上游 `@linxin666/dsh-pet`（Apache-2.0）是本项目的 fork 基线，但**不随本仓库分发**，
> 因此不作为随包组件列出；fork 关系与改动说明见 `NOTICE`。

## 仅构建期使用（不随包分发）

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| [`react`](https://react.dev/) / `react-dom` | 18.x | MIT | 宿主提供的 peer 依赖 |
| [`lightningcss`](https://lightningcss.dev/) | 1.x | MPL-2.0 | CSS Modules 编译 |
| [`tsdown`](https://tsdown.dev/) / [`rolldown`](https://rolldown.rs/) | 0.23.x | MIT | 打包 |
| [`typescript`](https://www.typescriptlang.org/) | 5.9.x | Apache-2.0 | 类型检查 |

## 仓库自带的美术资源

`models/panyinhu-placeholder/` 是**合成占位模型**，由 `tools/make-fixture-model.mjs`
生成（一个蒙皮小网格 + 两段动画 + 1×1 贴图），与仓库代码同为 Apache-2.0。

本仓库**不包含**任何游戏、动画或第三方角色资产。
