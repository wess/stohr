import 'package:flutter/material.dart';
import 'package:stohr/stohr.dart';
import '../api/index.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  Subscription? _sub;
  String? _err;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final s = await api.subscription();
      if (mounted) setState(() => _sub = s);
    } on StohrError catch (e) {
      if (mounted) setState(() => _err = e.message);
    }
  }

  String _gb(int bytes) {
    final gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 10) return '${gb.toStringAsFixed(0)} GB';
    return '${gb.toStringAsFixed(1)} GB';
  }

  Future<void> _signOut() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Sign out?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Sign out')),
        ],
      ),
    );
    if (ok != true) return;
    await session.signOut();
  }

  @override
  Widget build(BuildContext context) {
    final user = session.user;
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        children: [
          if (user != null) ...[
            const SizedBox(height: 12),
            Center(
              child: CircleAvatar(
                radius: 32,
                backgroundColor: theme.colorScheme.primaryContainer,
                child: Text(
                  (user.name.isNotEmpty ? user.name[0] : user.username[0]).toUpperCase(),
                  style: TextStyle(fontSize: 28, color: theme.colorScheme.onPrimaryContainer),
                ),
              ),
            ),
            const SizedBox(height: 12),
            Center(child: Text(user.name, style: theme.textTheme.titleMedium)),
            Center(child: Text('@${user.username}', style: theme.textTheme.bodySmall)),
            const SizedBox(height: 24),
          ],
          if (_sub != null)
            _StorageCard(sub: _sub!, formatGb: _gb)
          else if (_err != null)
            ListTile(title: Text(_err!, style: const TextStyle(color: Colors.redAccent))),
          const Divider(height: 32),
          ListTile(
            leading: const Icon(Icons.dns_outlined),
            title: const Text('Server'),
            subtitle: Text(session.baseUrl ?? '—', overflow: TextOverflow.ellipsis),
          ),
          if (user != null)
            ListTile(
              leading: const Icon(Icons.email_outlined),
              title: const Text('Email'),
              subtitle: Text(user.email),
            ),
          const Divider(height: 32),
          ListTile(
            leading: const Icon(Icons.logout, color: Colors.redAccent),
            title: const Text('Sign out', style: TextStyle(color: Colors.redAccent)),
            onTap: _signOut,
          ),
          const SizedBox(height: 24),
          Center(
            child: Text('stohr · v1.0.0',
                style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor)),
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

class _StorageCard extends StatelessWidget {
  final Subscription sub;
  final String Function(int) formatGb;
  const _StorageCard({required this.sub, required this.formatGb});

  @override
  Widget build(BuildContext context) {
    final used = sub.usedBytes.toDouble();
    final quota = sub.quotaBytes.toDouble();
    final pct = quota > 0 ? (used / quota).clamp(0.0, 1.0) : 0.0;
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(sub.tier.toUpperCase(), style: theme.textTheme.titleSmall),
                const Spacer(),
                Text('${formatGb(sub.usedBytes)} / ${formatGb(sub.quotaBytes)}',
                    style: theme.textTheme.bodySmall),
              ],
            ),
            const SizedBox(height: 10),
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: pct,
                minHeight: 8,
                backgroundColor: theme.colorScheme.surfaceContainerHighest,
              ),
            ),
            if (sub.status != null) ...[
              const SizedBox(height: 10),
              Text('Status: ${sub.status}', style: theme.textTheme.bodySmall),
            ],
          ],
        ),
      ),
    );
  }
}
