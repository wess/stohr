import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons/lucide_icons.dart';
import '../models.dart';
import '../state.dart';
import '../theme.dart';
import '../utils.dart';
import '../widgets.dart';

class SharesScreen extends ConsumerStatefulWidget {
  const SharesScreen({super.key});

  @override
  ConsumerState<SharesScreen> createState() => _SharesScreenState();
}

class _SharesScreenState extends ConsumerState<SharesScreen> {
  List<ShareLink> _shares = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final api = ref.read(apiProvider).requireValue;
    try {
      final list = await api.listShares();
      if (!mounted) return;
      setState(() { _shares = list; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() => _loading = false);
    }
  }

  Future<void> _copy(ShareLink s) async {
    final api = ref.read(apiProvider).requireValue;
    final url = api.publicShareUrl(s.token);
    await Clipboard.setData(ClipboardData(text: url));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Copied: $url')));
  }

  Future<void> _revoke(ShareLink s) async {
    final api = ref.read(apiProvider).requireValue;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Revoke share?'),
        content: Text(s.name),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('Revoke'),
          ),
        ],
      ),
    ) ?? false;
    if (!ok) return;
    await api.deleteShare(s.id);
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final api = ref.watch(apiProvider).valueOrNull;

    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(title: const Text('Shared links')),
      body: _loading
          ? Center(child: CircularProgressIndicator(color: p.brand))
          : RefreshIndicator(
              onRefresh: _load,
              color: p.brand,
              child: _shares.isEmpty
                  ? ListView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      children: [
                        SizedBox(
                          height: MediaQuery.of(context).size.height * 0.55,
                          child: const EmptyState(
                            icon: LucideIcons.link2,
                            title: 'No active shares',
                            subtitle: 'Share a file to create a public link',
                          ),
                        ),
                      ],
                    )
                  : ListView.builder(
                      itemCount: _shares.length,
                      itemBuilder: (ctx, i) {
                        final s = _shares[i];
                        return Material(
                          color: p.panel,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                            child: Row(
                              children: [
                                Container(
                                  width: 40,
                                  height: 40,
                                  decoration: BoxDecoration(
                                    color: p.accentBg,
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                  child: Icon(iconForMime(s.mime), color: p.brand, size: 22),
                                ),
                                const SizedBox(width: 14),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        s.name,
                                        style: TextStyle(color: p.text, fontSize: 15, fontWeight: FontWeight.w500),
                                        maxLines: 1, overflow: TextOverflow.ellipsis,
                                      ),
                                      const SizedBox(height: 2),
                                      Text(
                                        '${formatBytes(s.size)} · ${s.expiresAt == null ? "never expires" : "expires ${s.expiresAt!.toLocal().toString().split(".").first}"}',
                                        style: TextStyle(color: p.muted, fontSize: 12),
                                      ),
                                      const SizedBox(height: 4),
                                      Text(
                                        api?.publicShareUrl(s.token) ?? '',
                                        style: TextStyle(color: p.brand, fontSize: 11),
                                        maxLines: 1, overflow: TextOverflow.ellipsis,
                                      ),
                                    ],
                                  ),
                                ),
                                IconButton(icon: Icon(LucideIcons.copy, color: p.muted, size: 18), onPressed: () => _copy(s)),
                                IconButton(icon: Icon(LucideIcons.trash2, color: p.danger, size: 18), onPressed: () => _revoke(s)),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
            ),
    );
  }
}
