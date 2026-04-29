import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import '../capture/index.dart';
import '../session/index.dart';

class SettingsScreen extends StatefulWidget {
  final Session session;
  const SettingsScreen({super.key, required this.session});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _identity = TextEditingController();
  final _password = TextEditingController();
  final _mfaCode = TextEditingController();
  final _mfaBackup = TextEditingController();
  late final TextEditingController _server;
  bool _showServer = false;
  bool _useBackupCode = false;

  @override
  void initState() {
    super.initState();
    _server = TextEditingController(text: widget.session.config.serverUrl);
    widget.session.addListener(_onSessionChange);
  }

  void _onSessionChange() {
    if (!mounted) return;
    final cfg = widget.session.config;
    if (_server.text != cfg.serverUrl) _server.text = cfg.serverUrl;
    setState(() {});
  }

  @override
  void dispose() {
    widget.session.removeListener(_onSessionChange);
    _identity.dispose();
    _password.dispose();
    _mfaCode.dispose();
    _mfaBackup.dispose();
    _server.dispose();
    super.dispose();
  }

  Future<void> _signIn() async {
    await widget.session.setServerUrl(_server.text);
    final ok = await widget.session.signIn(_identity.text.trim(), _password.text);
    if (!mounted) return;
    if (!ok && widget.session.error != null && !widget.session.awaitingMfa) {
      _toast(widget.session.error!);
    }
  }

  Future<void> _submitMfa() async {
    final ok = await widget.session.completeMfa(
      code: _useBackupCode ? null : _mfaCode.text.trim(),
      backupCode: _useBackupCode ? _mfaBackup.text.trim() : null,
    );
    if (!mounted) return;
    if (!ok && widget.session.error != null) _toast(widget.session.error!);
  }

  Future<void> _capture(CaptureMode mode) async {
    final result = await widget.session.capture(mode);
    if (!mounted) return;
    if (result == null) {
      if (widget.session.error != null) _toast(widget.session.error!);
      return;
    }
    await Clipboard.setData(ClipboardData(text: result.shareUrl));
    _toast('Link copied');
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.session;
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Stohr'), elevation: 0),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          if (s.isSignedIn && s.user != null)
            _SignedInBlock(session: s, onCapture: _capture)
          else if (s.awaitingMfa)
            _MfaBlock(
              codeController: _mfaCode,
              backupController: _mfaBackup,
              useBackup: _useBackupCode,
              busy: s.busy,
              error: s.error,
              onToggle: () => setState(() {
                _useBackupCode = !_useBackupCode;
                _mfaCode.clear();
                _mfaBackup.clear();
              }),
              onSubmit: _submitMfa,
              onCancel: () => widget.session.cancelMfa(),
            )
          else
            _SignInBlock(
              identityController: _identity,
              passwordController: _password,
              serverController: _server,
              showServer: _showServer,
              onToggleServer: () => setState(() => _showServer = !_showServer),
              busy: s.busy,
              error: s.error,
              onSignIn: _signIn,
            ),
          const SizedBox(height: 24),
          Text('Recent captures', style: theme.textTheme.titleSmall),
          const SizedBox(height: 8),
          if (recents.items.isEmpty)
            Text('No captures yet — your screenshots will appear here.',
                style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor))
          else
            ...recents.items.map((r) => _RecentTile(item: r)),
        ],
      ),
    );
  }
}

class _SignInBlock extends StatelessWidget {
  final TextEditingController identityController;
  final TextEditingController passwordController;
  final TextEditingController serverController;
  final bool showServer;
  final VoidCallback onToggleServer;
  final bool busy;
  final String? error;
  final Future<void> Function() onSignIn;
  const _SignInBlock({
    required this.identityController,
    required this.passwordController,
    required this.serverController,
    required this.showServer,
    required this.onToggleServer,
    required this.busy,
    required this.error,
    required this.onSignIn,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Sign in', style: theme.textTheme.titleSmall),
        const SizedBox(height: 12),
        TextField(
          controller: identityController,
          decoration: const InputDecoration(
            labelText: 'Email or username',
            border: OutlineInputBorder(),
          ),
          autocorrect: false,
          textInputAction: TextInputAction.next,
        ),
        const SizedBox(height: 12),
        TextField(
          controller: passwordController,
          obscureText: true,
          decoration: const InputDecoration(
            labelText: 'Password',
            border: OutlineInputBorder(),
          ),
          onSubmitted: (_) => onSignIn(),
        ),
        if (showServer) ...[
          const SizedBox(height: 12),
          TextField(
            controller: serverController,
            decoration: const InputDecoration(
              labelText: 'Server URL',
              hintText: 'http://localhost:3000',
              border: OutlineInputBorder(),
            ),
            autocorrect: false,
            keyboardType: TextInputType.url,
          ),
        ],
        if (error != null) ...[
          const SizedBox(height: 8),
          Text(error!, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error)),
        ],
        const SizedBox(height: 16),
        FilledButton(
          onPressed: busy ? null : onSignIn,
          child: Text(busy ? 'Signing in…' : 'Sign in'),
        ),
        TextButton(
          onPressed: onToggleServer,
          child: Text(showServer ? 'Hide server URL' : 'Use a different server'),
        ),
      ],
    );
  }
}

class _MfaBlock extends StatelessWidget {
  final TextEditingController codeController;
  final TextEditingController backupController;
  final bool useBackup;
  final bool busy;
  final String? error;
  final VoidCallback onToggle;
  final Future<void> Function() onSubmit;
  final VoidCallback onCancel;
  const _MfaBlock({
    required this.codeController,
    required this.backupController,
    required this.useBackup,
    required this.busy,
    required this.error,
    required this.onToggle,
    required this.onSubmit,
    required this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Two-factor required', style: theme.textTheme.titleSmall),
        const SizedBox(height: 4),
        Text(
          useBackup
              ? 'Enter one of your saved backup codes.'
              : 'Enter the 6-digit code from your authenticator app.',
          style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
        ),
        const SizedBox(height: 12),
        if (useBackup)
          TextField(
            controller: backupController,
            autofocus: true,
            autocorrect: false,
            decoration: const InputDecoration(
              labelText: 'Backup code (xxxxx-xxxxx)',
              border: OutlineInputBorder(),
            ),
            onSubmitted: (_) => onSubmit(),
          )
        else
          TextField(
            controller: codeController,
            autofocus: true,
            keyboardType: TextInputType.number,
            maxLength: 6,
            decoration: const InputDecoration(
              labelText: '6-digit code',
              border: OutlineInputBorder(),
            ),
            onSubmitted: (_) => onSubmit(),
          ),
        if (error != null) ...[
          const SizedBox(height: 4),
          Text(error!, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error)),
        ],
        const SizedBox(height: 12),
        FilledButton(
          onPressed: busy ? null : onSubmit,
          child: Text(busy ? 'Verifying…' : 'Verify'),
        ),
        TextButton(
          onPressed: onToggle,
          child: Text(useBackup ? 'Use authenticator code instead' : 'Use a backup code'),
        ),
        TextButton(
          onPressed: onCancel,
          child: const Text('Cancel'),
        ),
      ],
    );
  }
}

class _SignedInBlock extends StatelessWidget {
  final Session session;
  final Future<void> Function(CaptureMode) onCapture;
  const _SignedInBlock({required this.session, required this.onCapture});

  @override
  Widget build(BuildContext context) {
    final user = session.user!;
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            CircleAvatar(
              radius: 18,
              backgroundColor: theme.colorScheme.primaryContainer,
              child: Text(
                (user.name.isNotEmpty ? user.name[0] : user.username[0]).toUpperCase(),
                style: TextStyle(color: theme.colorScheme.onPrimaryContainer),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('@${user.username}', style: theme.textTheme.titleSmall),
                  Text(user.email, style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor)),
                ],
              ),
            ),
            TextButton(
              onPressed: () => session.signOut(),
              child: const Text('Sign out'),
            ),
          ],
        ),
        const SizedBox(height: 16),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            FilledButton.icon(
              onPressed: session.busy ? null : () => onCapture(CaptureMode.region),
              icon: const Icon(Icons.crop_free),
              label: const Text('Capture region'),
            ),
            OutlinedButton.icon(
              onPressed: session.busy ? null : () => onCapture(CaptureMode.window),
              icon: const Icon(Icons.web_asset),
              label: const Text('Capture window'),
            ),
            OutlinedButton.icon(
              onPressed: session.busy ? null : () => onCapture(CaptureMode.screen),
              icon: const Icon(Icons.fullscreen),
              label: const Text('Full screen'),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Text('Or hit ⌘⇧8 from anywhere.',
            style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor)),
      ],
    );
  }
}

class _RecentTile extends StatelessWidget {
  final CaptureResult item;
  const _RecentTile({required this.item});

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: ListTile(
        title: Text(item.filename, maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: Text(item.shareUrl, maxLines: 1, overflow: TextOverflow.ellipsis),
        trailing: IconButton(
          icon: const Icon(Icons.copy),
          tooltip: 'Copy link',
          onPressed: () async {
            await Clipboard.setData(ClipboardData(text: item.shareUrl));
            if (!context.mounted) return;
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text('Link copied'), duration: Duration(seconds: 1)),
            );
          },
        ),
      ),
    );
  }
}
