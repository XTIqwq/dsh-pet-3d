# 给 agent 的自动部署说明

这份文档面向“把仓库交给另一个 agent，让它自动装好并加载宠物”的场景。
仓库根目录的 [`AGENTS.md`](../AGENTS.md) 是同一套步骤的机器可读契约，优先按它执行。

## 仓库里有什么

| 路径 | 内容 |
|---|---|
| `packages/dsh-pet-3d/` | 插件本体（源码 + 构建产物 + `cordis.patch.yml`） |
| `models/panyinhu-placeholder/` | **合成占位模型**（约 2 KB，Apache-2.0，可安全分发） |
| `tools/install-models.mjs` | 把 `models/*` 复制到 `$DSH_HOME/models/` |
| `AGENTS.md` | 给 agent 的最短部署契约 |

## 一条命令跑通（Windows）

```powershell
pnpm install
pnpm -C packages/dsh-pet-3d build
pnpm -C packages/dsh-pet-3d pack
$tgz = (Get-ChildItem packages/dsh-pet-3d/dsh-pet-3d-*.tgz |
  Sort-Object LastWriteTime | Select-Object -Last 1).FullName
pnpm --dir "$env:USERPROFILE\.dsh\profiles\desktop" add $tgz
node tools/install-models.mjs
```

重启 DSH 后：

```powershell
Invoke-RestMethod http://127.0.0.1:19387/api/pet3d/models
```

看到 `panyinhu-placeholder` 即成功；GUI 角落会出现一个几何小宠物。

## Linux / macOS

```bash
pnpm install
pnpm -C packages/dsh-pet-3d build
pnpm -C packages/dsh-pet-3d pack
pnpm --dir "${DSH_HOME:-$HOME/.dsh}/profiles/desktop" add "$(ls -t packages/dsh-pet-3d/dsh-pet-3d-*.tgz | head -1)"
node tools/install-models.mjs
```

## 关键选择

- **profile 不要猜错**：DSH Desktop 一般是 `profiles/desktop`；`dsh web` 用的是
  `profiles/web`。装错 profile 的表现和“没装”完全一样。
- **用 tarball，不要用目录/link**：v1.0.3 虽然 `link:` 也能跑（host 自带
  schemastery、导入器自带 three），但 tarball 的安装器行为最标准。
- **不要手工加 `pet3d` 行**：包里的 `cordis.patch.yml` 会自己插入；手工加会重复。

## 换成自己的模型

1. 按 `docs/交付模板-原版模型.md` 准备目录（`.import/model.glb`、`clips.json`、
   `clips.bin`、`textures/`、`options.json`）；
2. 放到 `$DSH_HOME/models/<你的 id>/`；
3. `options.json` 的 `phase` 指向 `clips.json` 里的真实动作名；
4. 可选：`appearance.json`、`interactions.json`、`choreography.json`。

插件只扫描 `$DSH_HOME/models/`，不需要改代码。

## 验证清单

- [ ] `GET /api/pet3d/models` 至少返回一个模型
- [ ] `GET /api/pet3d/state` 的 `model` 非空、`display.visible` 为 true
- [ ] GUI 角落有宠物，悬停出现 🐻
- [ ] 悬浮菜单能开，「互动」能播动作
- [ ] 重启 DSH 后宠物位置不变（v1.0.2+）

## 故障排查

| 现象 | 处理 |
|---|---|
| `/api/pet3d/*` 404 | 装到了错误的 profile；换成 GUI 实际使用的那个 |
| `ERR_MODULE_NOT_FOUND` | 用目录 `link:` 装了旧包；改用 `pnpm add <tgz>` |
| 模型列表为空 | `node tools/install-models.mjs --force`，确认 `.import/model.glb` 在 |
| 重新导入提示缺 `three` | 包低于 1.0.3；升级到 1.0.3（导入器已自带 three） |
| 位置重启复位 | 包低于 1.0.2；升级 |
