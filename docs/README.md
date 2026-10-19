# 文档索引（docs/）

公开仓库只保留**与使用、设计直接相关**的文档；内部交接、交付请求、开发日志、
检查点与本机路径地图不随仓库分发。

## 先看这几份

| 文档 | 内容 |
|---|---|
| [`插件安装与排障.md`](插件安装与排障.md) | 装插件、重启、常见故障与活体检查命令 |
| [`悬浮菜单与配饰.md`](悬浮菜单与配饰.md) | 悬浮菜单 / 款式组 / 配饰穿脱 / 互动面板的设计与守卫 |
| [`agent-deploy.md`](agent-deploy.md) | 给其他 agent 的自动部署 / 加载清单（含占位模型） |
| [`已知问题.md`](已知问题.md) | 当前版本未修复的缺陷（P0 自动重导入不退避等） |

## 代码里的文档

每个 `packages/dsh-pet-3d/src/**` 模块开头都写了它的设计取舍；根目录 `README.md`
是仓库门面，`CHANGELOG.md` 记录版本变更，`AUTHORS.md` / `NOTICE` /
`THIRD-PARTY-NOTICES.md` 是署名与第三方许可。

## 模型数据

插件本身只带代码，模型是数据。模型目录的格式见 `packages/dsh-pet-3d/README.md`，
自带的可运行示例是 `models/panyinhu-placeholder/`。
