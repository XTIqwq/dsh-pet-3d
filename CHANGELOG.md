# CHANGELOG

## v1.0.3 — 2026-10-19（零运行时依赖）

- **导入器自带 three**：`tools/pet3d-import.mjs` 改为 import
  `tools/vendor/three-node.mjs`（three 0.171 + 容错版 FBXLoader + GLTFExporter，
  用 `node tools/build-three-node.mjs` 生成）。导入器现在在**没有任何 npm 依赖**的
  目录里也能加载，`link:` 安装的「重新导入」不再缺 `three`。
- **包不再声明运行时依赖**：`dependencies` 清空，`@deepseek-ai/schemastery`
  与 `three` 移到 `devDependencies`（只用于构建）。宿主半边已把 schemastery 打进
  `lib/index.js`。
- `files` 增加 `tools/vendor/three-node.mjs`；`prepack` 同时复制导入器与 vendor bundle。
- 版本 `1.0.2` → `1.0.3`。

## v1.0.2 — 2026-10-19（安装与持久化修复）

根据 1.0.1 缺陷报告修复：

- **P0 `link:` 安装宿主半边起不来**：把 `@deepseek-ai/schemastery` 打进
  `lib/index.js`（`noExternal`），host bundle 现在只剩 node 内置 import。
  `dsh plugin add <目录>` 生成的 `link:` 安装不再需要 profile 提供 schemastery。
- **P1 拖动位置重启/改设置后复位**：`syncSettings()` 之前无条件用 schema 默认值
  `setDisplay()` 覆盖持久化值；改为只 patch **profile 显式设置过**的字段
  （`explicitDisplayOf`），未设置字段保留 `pet3d.json` 里的拖动位置。
- **P1 导入器缺 `three` 时错误不可读**：子进程 stderr 命中 `Cannot find package 'three'`
  时返回明确指引（profile 里 `pnpm add three@0.186.1`，或改用 tgz 安装）。
- **P2 `import.json.importerScript` 相对路径每次重导入都要确认**：
  `importConflict()` 对相对路径按文件名比较；打包模型时不再写入相对 importerScript。
- **P2 自动重导入每 5 秒刷同一条日志**：sweep 按「目录 + 原因」去重，原因变化/恢复后才再报。
- **P3 安装文档**：明确「不要用 `dsh plugin add <目录>` 装发布包（会变 link:）」、
  profile 选择（Desktop `desktop` / `dsh web` `web`）、以及**不要手工再加 `pet3d` 行**
  （插件自带 patch 已插入，手工加会重复）。

## v1.0.1 — 2026-10-19（安全修复）

- **修复资源路由的只读路径穿越**：`/pet3d/<id>/<file>` 的 `<id>` 之前未做校验，
  编码后的 `..` 序列可让 `join(modelsRoot, id)` 跳出模型根，读到 `$DSH_HOME` 乃至更外层
  的 `.json` / 图片 / `.glb`（仅限本机或已配对设备，且受扩展名白名单限制）。
  现在 `modelDirectory()` 只接受纯目录名（拒绝 `/`、`\`、`NUL`、`.`、`..`、盘符前缀）。
- 新增 `tools/check-pet3d-route-safety.mjs`：不启动宿主即可回归验证 id 校验。
- 已用真实请求复现过修复前行为，修复后该请求由路由拒绝（403/404）；宿主需重启后生效。

## v1.0.0 — 2026-10-19

第一个可发布版本（自用）。这一版把 3D 桌宠从"能跑的现场"整理成"能安装的插件"。

### 新增

- **宠物互动面板**（悬浮菜单 → 互动）：摸摸 / 招呼 / 转圈 / 喂食，每个按钮播一条
  真实动作 + 一句台词气泡（3 秒淡出）+ 好感度进度条（`localStorage` 持久化，换模型各记一份）。
  同一按钮 2 秒冷却；动作播不了会明说，不假装成功。
- 互动数据 `interactions.json` 放进模型目录（热更新 ≤2 秒），没配的模型显示
  「这个模型还没配互动」，不报错、不空白、不放空按钮。
- `LICENSE`（Apache-2.0）随包发布；`package.json` 的 `files` 白名单补上它。

### 变更

- 模型目录收敛到一套：多套换装变体不再随仓库或分享包分发，只保留一份基础模型
  （模型本身是数据，不进版本库）。
- 悬停小熊 → 悬浮菜单：配饰穿脱 / 款式组（有数据时出现）/ 互动；原版模型当前是 1 件配饰（帽子）。
- 版本号 `0.2.0` → `1.0.0`；包描述同步到"换装/配饰/互动"。
- README 增加发布版入口（是什么 / 怎么装 / 怎么用 / 目录 / 模型清单 / 已知问题）。

### 验证

- 离线守卫 7/7 绿（`tools/check-pet3d*.mjs`）；`tsc` 0 错误。
- `tools/check-appearance.mjs`：`panyinhu` 全绿（`_fixture` 是测试夹具，验收前已清理）。
- `tools/verify-pet-menu.mjs`：悬浮菜单 + 互动全绿（含动作真的切换、台词、好感度刷新持久化）。
- `tools/verify-live-window.mjs`：宠物在真实浏览器里挂载、WebGL 真的在画、像素在动。

### 已知问题（冻结）

1. **脖子一圈 / 面膜边缘漏红**：模型内部没有封口件，侧后/下方会透出背景。已冻结，
   下轮用单变量实验重验根因（`docs/修复请求-脖子漏红.md`）。
2. **`body_top2` 退化网格**：源文件 0 顶点占位，导入时被剔除，不影响使用。
3. **模型 UV 口径**：本批固定 `--uv-keep`，换新模型要按 `导出说明.txt` 核对。
