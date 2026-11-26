# 收尾状态

## 2026-11-26 本地启动脚本 + Wayland 视觉确认
### 本次完成
- 新增 `run-linux.sh`：启动本地构建产物（自动选 release/debug），原生 Wayland 优先
  （有 `WAYLAND_DISPLAY` 且未显式设 `GDK_BACKEND` 时导出 `GDK_BACKEND=wayland`，不走 XWayland），
  并在检测到已运行实例时提示单实例转发风险。`bash -n` 语法自检通过。
- 用户确认：上一轮的 Wayland 黑屏修复在真机 Wayland 下**已正常工作**（黑屏消失）。
- 分支已推到 fork：`fix/linux-wayland-subsurface-resize` @ `362f5bd2`。
### 未完成与挂账
- 上游投递方式待定：`chen08209/FlClash` 已**关闭 Pull Requests**（`GET/POST /pulls` 一律 404，
  按钮置灰），无法建 PR；下一步改用 Issue 投递补丁，或按仓库 CONTRIBUTING 约定处理。
### 验证与版本
- 上游为网络根仓（`fork:false`，owner 个人账号）；fork 网络 4358 个仓。
- `gh` 令牌 scopes `gist, read:org, repo`；同仓（fork）建 PR 返回 201，跨仓建 PR 返回 404——
  证明是上游关闭 PR，非账号/令牌权限问题。
### 跳过项
- 跳过 PR 创建：上游禁用 PR 功能（详见「未完成与挂账」）。
- `run-linux.sh` 提交时跳过 `flutter analyze`/`flutter test`：仅新增 shell 脚本，无 Dart 改动。

## 2026-11-26 Linux/Wayland 黑屏修复
### 本次完成
- 定位 Linux/Wayland 下 Flutter 内容只画在窗口左下角、其余为黑色背景的根因：`FlView` 的子表面
  （subsurface）随控件 `size_allocate` 附着，而 GTK 在 map 事件之后才创建出新表面；`on_map_event`
  里原来同步调用 `queue_resize_tree` 跑得太早，画面停在 GL 原点的陈旧帧上。
- 在 `plugins/rust_api/rust/src/window/linux.rs` 修复：`on_map_event` 改为 `post(Box::new(reallocate_view))`
  延到 g_idle 确保表面已存在；新增共享 `reallocate_view()`；`on_settle_timeout` 顶部补一次以覆盖首次显示。
- 验证：`cargo check` 通过（无 warning）；debug bundle 重编 `librust_api.so` 通过；新增 0 行独立注释。
### 未完成与挂账
- （视觉确认已于 2026-11-26 由用户在真机 Wayland 完成，本条闭环。）
### 验证与版本
- Flutter 3.50.1；分支 `fix/linux-wayland-subsurface-resize`。
- `cargo check`：`Finished dev profile`（exit 0）。
### 跳过项
- 跳过 `flutter analyze`/`flutter test`：本轮仅改 Rust，无 Dart 改动。
