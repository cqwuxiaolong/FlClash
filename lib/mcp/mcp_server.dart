import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

import 'package:fl_clash/enum/enum.dart';
import 'package:fl_clash/providers/providers.dart';
import 'package:fl_clash/state.dart';

/// A loopback-only Model Context Protocol server that exposes FlClash controls
/// over Streamable HTTP, so a test client can drive the core without the GUI.
///
/// Only started when `FLCLASH_MCP_PORT` is set, so it stays off in normal runs.
class McpServer {
  McpServer._(this._server);

  final HttpServer _server;
  static McpServer? _instance;

  static const String _protocolVersion = '2024-11-05';
  static const String _serverVersion = '0.1.0';

  static Uri? get address {
    final server = _instance?._server;
    if (server == null) {
      return null;
    }
    return Uri(
      scheme: 'http',
      host: server.address.address,
      port: server.port,
      path: '/mcp',
    );
  }

  static Future<void> tryStartFromEnvironment() async {
    final raw = Platform.environment['FLCLASH_MCP_PORT'];
    if (raw == null || raw.isEmpty) {
      return;
    }
    final port = int.tryParse(raw);
    if (port == null) {
      debugPrint('MCP: invalid FLCLASH_MCP_PORT=$raw');
      return;
    }
    await start(port: port);
  }

  static Future<void> start({required int port}) async {
    if (_instance != null) {
      return;
    }
    try {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, port);
      final instance = McpServer._(server);
      _instance = instance;
      server.listen(
        instance._handle,
        onError: (Object error) => debugPrint('MCP error: $error'),
      );
      debugPrint(
        'MCP listening on http://${server.address.address}:${server.port}/mcp',
      );
    } catch (error) {
      debugPrint('MCP failed to bind on $port: $error');
    }
  }

  Future<void> close() async {
    _instance = null;
    await _server.close(force: true);
  }

  Future<void> _handle(HttpRequest request) async {
    final response = request.response;
    response.headers
      ..set('access-control-allow-origin', '*')
      ..set('access-control-allow-headers', 'content-type,mcp-session-id')
      ..set('access-control-allow-methods', 'GET,POST,OPTIONS,DELETE');
    if (request.method == 'OPTIONS') {
      await response.close();
      return;
    }
    if (request.method == 'GET' && request.uri.path == '/health') {
      response
        ..headers.contentType = ContentType.text
        ..write('flclash-mcp ok');
      await response.close();
      return;
    }
    if (request.method != 'POST') {
      response.statusCode = HttpStatus.methodNotAllowed;
      await response.close();
      return;
    }
    final body = await utf8.decoder.bind(request).join();
    Object? payload;
    var isNotification = false;
    try {
      final decoded = jsonDecode(body);
      if (decoded is List) {
        final responses = <Map<String, Object?>>[];
        for (final item in decoded) {
          final message = await _dispatch(item);
          if (message != null) {
            responses.add(message);
          }
        }
        payload = responses;
      } else {
        final message = await _dispatch(decoded);
        if (message == null) {
          isNotification = true;
        } else {
          payload = message;
        }
      }
    } catch (error) {
      payload = _error(null, -32700, 'parse error: $error');
    }
    if (payload == null) {
      response.statusCode = HttpStatus.accepted;
    } else {
      response.headers.contentType = ContentType.json;
      response.write(jsonEncode(payload));
    }
    await response.close();
    assert(isNotification || payload != null);
  }

  Future<Map<String, Object?>?> _dispatch(Object? request) async {
    if (request is! Map) {
      return _error(null, -32600, 'invalid request');
    }
    final id = request['id'];
    final method = request['method'];
    final params = request['params'];
    if (method is! String) {
      return id == null ? null : _error(id, -32600, 'missing method');
    }
    try {
      switch (method) {
        case 'initialize':
          final requested = params is Map ? params['protocolVersion'] : null;
          return _ok(id, {
            'protocolVersion': requested is String
                ? requested
                : _protocolVersion,
            'capabilities': {'tools': <String, Object?>{}},
            'serverInfo': {'name': 'flclash', 'version': _serverVersion},
          });
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          return _ok(id, <String, Object?>{});
        case 'tools/list':
          return _ok(id, {'tools': _tools});
        case 'tools/call':
          return await _handleToolCall(id, params);
        default:
          return _error(id, -32601, 'method not found: $method');
      }
    } catch (error) {
      debugPrint('MCP $method error: $error');
      return _error(id, -32603, '$error');
    }
  }

  Future<Map<String, Object?>> _handleToolCall(Object? id, Object? params) async {
    final map = params is Map ? params : const <String, Object?>{};
    final name = map['name'];
    final args = map['arguments'] is Map
        ? Map<String, Object?>.from(map['arguments'] as Map)
        : <String, Object?>{};
    if (name is! String) {
      return _error(id, -32602, 'missing tool name');
    }
    try {
      final result = await _callTool(name, args);
      return _ok(id, {
        'content': [
          {'type': 'text', 'text': jsonEncode(result)},
        ],
        'isError': false,
      });
    } catch (error) {
      return _ok(id, {
        'content': [
          {'type': 'text', 'text': '$error'},
        ],
        'isError': true,
      });
    }
  }

  Future<Object?> _callTool(String name, Map<String, Object?> args) async {
    switch (name) {
      case 'status':
        return _status();
      case 'set_running':
        final running = args['value'] == true;
        final ok = await globalState
            .container
            .read(setupActionProvider.notifier)
            .setRunning(running);
        return {
          'requested': running,
          'running': globalState.container.read(isStartProvider),
          'ok': ok,
        };
      case 'set_mode':
        final requested = args['mode'];
        if (requested is! String) {
          throw ArgumentError('mode must be rule|global|direct');
        }
        final mode = Mode.values.firstWhere(
          (value) => value.name == requested,
          orElse: () => throw ArgumentError('unknown mode: $requested'),
        );
        globalState.container
            .read(setupActionProvider.notifier)
            .changeMode(mode);
        return {'mode': mode.name};
      case 'change_proxy':
        final groupName = args['groupName'];
        final proxyName = args['proxyName'];
        if (groupName is! String || proxyName is! String) {
          throw ArgumentError('change_proxy needs groupName and proxyName');
        }
        await globalState
            .container
            .read(proxiesActionProvider.notifier)
            .changeProxy(groupName: groupName, proxyName: proxyName);
        return {'group': groupName, 'proxy': proxyName};
      case 'groups':
        return {
          'groups': globalState.container.read(groupsProvider).map((group) {
            return {
              'name': group.name,
              'type': group.type.name,
              'now': group.now,
              'proxies': group.all.length,
            };
          }).toList(),
        };
      case 'logs':
        final limit = (args['limit'] as num?)?.toInt() ?? 50;
        final all = globalState.container.read(logsProvider).list;
        final start = all.length > limit ? all.length - limit : 0;
        return {
          'logs': all.sublist(start).map((log) {
            return {
              'time': log.dateTime,
              'level': log.logLevel.name,
              'message': log.payload,
            };
          }).toList(),
        };
      default:
        throw ArgumentError('unknown tool: $name');
    }
  }

  Map<String, Object?> _status() {
    final container = globalState.container;
    final patch = container.read(patchClashConfigProvider);
    return {
      'running': container.read(isStartProvider),
      'coreStatus': container.read(coreStatusProvider).name,
      'mode': patch.mode.name,
      'mixedPort': patch.mixedPort,
      'tunEnable': patch.tun.enable,
      'systemProxy': container.read(networkSettingProvider).systemProxy,
      'vpnEnable': container.read(vpnSettingProvider).enable,
      'version': container.read(versionProvider),
      'mcpServer': address.toString(),
    };
  }

  static Map<String, Object?> _ok(Object? id, Object? result) {
    return {'jsonrpc': '2.0', 'id': id, 'result': result};
  }

  static Map<String, Object?> _error(Object? id, int code, String message) {
    return {'jsonrpc': '2.0', 'id': id, 'error': {'code': code, 'message': message}};
  }

  static final List<Map<String, Object?>> _tools = [
    {
      'name': 'status',
      'description': 'FlClash 运行状态：是否运行、内核状态、模式、mixed 端口、TUN、系统代理。',
      'inputSchema': {'type': 'object', 'properties': <String, Object?>{}},
    },
    {
      'name': 'set_running',
      'description': '打开或关闭总运行开关（下发/收回内核监听与系统代理）。',
      'inputSchema': {
        'type': 'object',
        'properties': {
          'value': {'type': 'boolean', 'description': 'true=运行, false=停止'},
        },
        'required': ['value'],
      },
    },
    {
      'name': 'set_mode',
      'description': '切换运行模式 rule|global|direct。',
      'inputSchema': {
        'type': 'object',
        'properties': {
          'mode': {'type': 'string', 'enum': ['rule', 'global', 'direct']},
        },
        'required': ['mode'],
      },
    },
    {
      'name': 'change_proxy',
      'description': '在某个代理分组里选择出站节点。',
      'inputSchema': {
        'type': 'object',
        'properties': {
          'groupName': {'type': 'string'},
          'proxyName': {'type': 'string'},
        },
        'required': ['groupName', 'proxyName'],
      },
    },
    {
      'name': 'groups',
      'description': '列出代理分组、类型、当前节点与节点数量。',
      'inputSchema': {'type': 'object', 'properties': <String, Object?>{}},
    },
    {
      'name': 'logs',
      'description': '返回内核最近的日志（默认 50 条）。',
      'inputSchema': {
        'type': 'object',
        'properties': {
          'limit': {'type': 'integer', 'description': '返回条数上限'},
        },
      },
    },
  ];
}
