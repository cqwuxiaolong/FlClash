# 收尾状态

## 2026-11-26 Linux/Wayland 黑屏修复

### 本次完成
- 定位 Linux/Wayland 下 Flutter 内容只画在窗口左下角、其余为黑色背景的根因：`FlView` 的子表面
  （subsurface）随控件 `size_allocate` 附着，而 GTK 在 map 事件之后才创建出新表面；`on_map_event`
  里原来同步调用 `queue_resize_tree` 跑得太早，画面停在 GL 原点的陈旧帧上。
- 在 `plugins/rust_api/rust/src/window/linux.rs` 修复：
  1. `on_map_event` 改为 `post(Box::new(reallocate_view))`，把重新分配推迟到 g_idle，确保表面已存在。
  2. 新增共享函数 `reallocate_view()`，封装 `queue_resize_tree` 调用。
  3. `on_settle_timeout` 顶部补一次 `reallocate_view()`，configure 稳定后再分配一次，覆盖首次显示。
- 验证：`cargo check` 通过（无 warning，`Finished dev profile`）；
  `flutter build linux --debug --dart-define-from-file=env.json --dart-define=SAFE_MODE=true` 通过，
  重新编译出 `librust_api.so`。新增 0 行独立注释，符合 comment-density 门禁。

### 未完成与挂账
- 视觉确认未做：本机为 GNOME/Wayland，无可用截图工具（grim 等未安装，且禁止为验证安装桌面 app），
  无法从命令行截图核对。需退出已安装的 `com.follow.clash` 后运行 debug bundle，或手动拖动窗口触发
  configure-settle 来确认黑屏消失。
- 本次改动仅触及 Rust 侧，未跑 `flutter analyze`/`flutter test`（Dart 侧无改动）。

### 验证与版本
- Flutter 3.50.1；分支 `fix/linux-wayland-subsurface-resize`。
- `cargo check`：`Finished dev profile`（exit 0）。
- debug bundle：`build/linux/x64/debug/bundle/FlClash` 已生成，`lib/librust_api.so` 已重编。

### 跳过项
- 跳过视觉验证：因禁止安装桌面 app 且本机无 Wayland 截图工具（详见「未完成与挂账」）。
- 跳过 `flutter analyze`/`flutter test`：本轮无 Dart 代码改动，仅改 Rust。
