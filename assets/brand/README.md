# 品牌资产源文件

这里放的是**源文件**，不是构建产物。`src-tauri/icons/` 下那些是从这里导出的
成品（压缩过、切好尺寸），改图标时改这里再重新导出，不要反过来。

| 文件 | 是什么 |
| --- | --- |
| `vibe-board-icon-source.png` | 应用图标原图，深色圆角底 + 白色 VB 字标。`src-tauri/icons/` 下的 `.ico`/`.icns`/各尺寸 PNG 都由它生成。 |
| `vibe-board-logo-source.png` | 纯 logo，透明底，无外框。用于 README、网站等需要脱离图标外框的场合。 |

两者均为 2026-09-07 生成，早于 `src-tauri/icons/` 里的成品 14 分钟。
此前它们散落在仓库外、没有版本管理，2026-09-18 收进仓库。

`assets/readme/` 放的是 README 用的展示图，与这里的品牌源文件分开。
