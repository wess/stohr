import 'package:flutter/material.dart';
import 'package:stohr/stohr.dart';
import '../api/index.dart';

class ShareOptions {
  final int expiresIn;
  final String? password;
  final bool burnOnView;
  ShareOptions({required this.expiresIn, this.password, this.burnOnView = false});
}

const _durations = <(String, int)>[
  ('1 hour', 3600),
  ('1 day', 86400),
  ('7 days', 604800),
  ('30 days', 2592000),
];

Future<Share?> showCreateShareSheet(BuildContext context, FileItem file) {
  return showModalBottomSheet<Share>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
      child: _CreateShareForm(file: file),
    ),
  );
}

class _CreateShareForm extends StatefulWidget {
  final FileItem file;
  const _CreateShareForm({required this.file});
  @override
  State<_CreateShareForm> createState() => _CreateShareFormState();
}

class _CreateShareFormState extends State<_CreateShareForm> {
  int _expires = 86400;
  bool _passwordOn = false;
  bool _burn = false;
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final share = await api.createShare(
        widget.file.id,
        expiresInSeconds: _expires,
        password: _passwordOn ? _password.text.trim() : null,
        burnOnView: _burn,
      );
      if (mounted) Navigator.pop(context, share);
    } on StohrError catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text('Share link',
                      style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
                ),
                IconButton(
                  icon: const Icon(Icons.close, size: 20),
                  onPressed: () => Navigator.pop(context),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(widget.file.name,
                style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
                maxLines: 1,
                overflow: TextOverflow.ellipsis),
            const SizedBox(height: 18),
            Text('Expires in', style: theme.textTheme.bodySmall),
            const SizedBox(height: 6),
            Wrap(
              spacing: 8,
              children: [
                for (final (label, secs) in _durations)
                  ChoiceChip(
                    label: Text(label),
                    selected: _expires == secs,
                    onSelected: (_) => setState(() => _expires = secs),
                  ),
              ],
            ),
            const SizedBox(height: 18),
            SwitchListTile.adaptive(
              contentPadding: EdgeInsets.zero,
              title: const Text('Password protect'),
              value: _passwordOn,
              onChanged: (v) => setState(() => _passwordOn = v),
            ),
            if (_passwordOn)
              TextField(
                controller: _password,
                obscureText: true,
                autocorrect: false,
                decoration: const InputDecoration(labelText: 'Password'),
              ),
            SwitchListTile.adaptive(
              contentPadding: EdgeInsets.zero,
              title: const Text('Self-destruct after first non-owner view'),
              subtitle: const Text('Link works exactly once for someone else'),
              value: _burn,
              onChanged: (v) => setState(() => _burn = v),
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!,
                  style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error)),
            ],
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _busy || (_passwordOn && _password.text.isEmpty) ? null : _create,
              child: _busy
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Create link'),
            ),
          ],
        ),
      ),
    );
  }
}
