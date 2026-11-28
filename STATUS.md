# 收尾状态

## 2026-11-28 内建 MCP server + 本地构建联网诊断
### 本次完成
- 新增 `lib/mcp/mcp_server.dart`：回环口内建 MCP server（仅当 `FLCLASH_MCP_PORT` 设置时启用），
  用 Streamable-HTTP（JSON 单响应）实现 JSON-RPC 的 `initialize`/`tools/list`/`tools/call`/`ping`，
  暴露 `status`/`set_running`/`set_mode`/`change_proxy`/`groups`/`logs` 六个工具，全部经
  `globalState.container` 调用 provider 与 action，使测试方可脱离 GUI 驱动内核。
- `lib/bootstrap.dart`：在 `initProvider=true` 之后 `unawaited(McpServer.tryStartFromEnvironment())`，
  不阻塞启动时序；release 默认（未设环境变量）不启用。
- `run-linux.sh`：默认导出 `FLCLASH_MCP_PORT=39789`（可用 `FLCLASH_MCP_PORT` 覆盖、设空禁用）并默认
  进入便携模式（`APPIMAGE`，可用 `FLCLASH_PORTABLE=0` 关闭）；脚本启动即自带 MCP、自动运行。
- 诊断本地构建无法上网根因：① 运行总开关从未下发（日志无 `listener.start`）；② Linux+systemd 下
  `hasHelperService=true`，监听交给缺失的 `flclash-helper.service`。便携模式（`hasHelperService=false`）
  + `autoRun` 后，监听与系统代理生效：`7890` 监听、`gsettings=manual`、代理访问 google 返回 `204`。
- 修复编译：把 `plugins/prism_ui` 对齐主仓 pin 的 `6c47901`（工作区曾被推进到 `cae9a43`，新版
  `measure` 返回函数与主仓按 `double` 调用的代码不匹配）。
### 未完成与挂账
- 便携模式下 TUN/虚拟网卡不可用（FlClash 对 AppImage 路径 `authorizeCore` 返回 error），仅走系统代理；
  需 TUN 时用 `FLCLASH_PORTABLE=0` 并正确安装 helper service。
- MCP 仅做 JSON 单响应，未实现 SSE/会话；暂未暴露 connections/带宽工具。
- 是否把该 MCP（`http://127.0.0.1:39789/mcp`）登记进 Codex 端配置，待用户决定。
- 上游 PR 投递仍待办（沿用上轮：上游关闭 PR，改走 Issue）。
### 验证与版本
- `flutter analyze lib/mcp/mcp_server.dart lib/bootstrap.dart`：No issues。`flutter build linux --release`：✓ Built。
- MCP 实测：`initialize`/`tools/list`/`tools/call` 正常；`status` 返回 running=true、coreStatus=connected、
  mixedPort=7890；`ss` 显示 `127.0.0.1:7890 LISTEN(FlClashCore)`；`gsettings` 代理 mode=manual；
  `curl -x http://127.0.0.1:7890 …generate_204` = 204；`groups` 返回 OneX 分组与节点。
- 分支 `fix/linux-wayland-subsurface-resize`。
### 跳过项
- 未跑全量 `flutter test`：本轮为独立新增 `mcp_server.dart` 与 bootstrap 启动注入，无 provider/模型/DB schema 改动。
- TUN 真机验证跳过：便携模式按设计禁用 TUN。


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
