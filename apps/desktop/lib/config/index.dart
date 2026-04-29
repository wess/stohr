import 'dart:convert';
import 'dart:io';
import 'package:path_provider/path_provider.dart';

class StohrConfig {
  final String serverUrl;

  const StohrConfig({required this.serverUrl});

  static const StohrConfig _defaults = StohrConfig(
    serverUrl: 'http://localhost:3000',
  );

  StohrConfig copyWith({String? serverUrl}) =>
      StohrConfig(serverUrl: serverUrl ?? this.serverUrl);

  Map<String, dynamic> toJson() => {'serverUrl': serverUrl};

  factory StohrConfig.fromJson(Map<String, dynamic> j) =>
      StohrConfig(serverUrl: j['serverUrl'] as String? ?? _defaults.serverUrl);
}

bool _isLocalHost(String host) {
  final h = host.toLowerCase();
  if (h == 'localhost' || h == '127.0.0.1' || h == '0.0.0.0' || h == '::1') return true;
  if (RegExp(r'^192\.168\.').hasMatch(h)) return true;
  if (RegExp(r'^10\.').hasMatch(h)) return true;
  if (RegExp(r'^172\.(1[6-9]|2\d|3[01])\.').hasMatch(h)) return true;
  if (h.endsWith('.local')) return true;
  return false;
}

/// Normalize whatever the user typed (or whatever's stored on disk) into a
/// sane base URL: missing scheme → http for localhost-y hosts / https
/// otherwise; stored https against a localhost-y host → downgraded to http
/// so we don't WRONG_VERSION_NUMBER on local dev; trailing slashes stripped.
String normalizeBaseUrl(String input) {
  var trimmed = input.trim();
  if (trimmed.isEmpty) return '';
  trimmed = trimmed.replaceAll(RegExp(r'/+$'), '');
  if (!trimmed.contains('://')) {
    final hostPart = trimmed.split('/').first;
    final host = hostPart.split(':').first;
    final scheme = _isLocalHost(host) ? 'http' : 'https';
    return '$scheme://$trimmed';
  }
  try {
    final uri = Uri.parse(trimmed);
    if (uri.scheme == 'https' && _isLocalHost(uri.host)) {
      return uri.replace(scheme: 'http').toString().replaceAll(RegExp(r'/+$'), '');
    }
  } catch (_) {
    // Fall through — let the SDK surface the error if the URL is truly invalid.
  }
  return trimmed;
}

Future<File> _configFile() async {
  final dir = await getApplicationSupportDirectory();
  await dir.create(recursive: true);
  return File('${dir.path}/config.json');
}

Future<StohrConfig> loadConfig() async {
  final f = await _configFile();
  StohrConfig cfg;
  if (!await f.exists()) {
    cfg = StohrConfig._defaults;
  } else {
    try {
      final raw = await f.readAsString();
      cfg = StohrConfig.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      cfg = StohrConfig._defaults;
    }
  }
  // Repair stale https://localhost-style URLs from older builds.
  final normalized = normalizeBaseUrl(cfg.serverUrl);
  if (normalized != cfg.serverUrl) {
    cfg = cfg.copyWith(serverUrl: normalized);
    await saveConfig(cfg);
  }
  return cfg;
}

Future<void> saveConfig(StohrConfig cfg) async {
  final f = await _configFile();
  final clean = StohrConfig(serverUrl: normalizeBaseUrl(cfg.serverUrl));
  await f.writeAsString(jsonEncode(clean.toJson()));
}
