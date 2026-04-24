import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons/lucide_icons.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';

class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  late final TextEditingController _name;
  late final TextEditingController _email;
  final _currentPw = TextEditingController();
  final _newPw = TextEditingController();
  final _confirmPw = TextEditingController();

  String? _profileOk;
  String? _profileErr;
  String? _pwOk;
  String? _pwErr;

  @override
  void initState() {
    super.initState();
    final user = ref.read(sessionProvider);
    _name = TextEditingController(text: user?.name ?? '');
    _email = TextEditingController(text: user?.email ?? '');
  }

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _currentPw.dispose();
    _newPw.dispose();
    _confirmPw.dispose();
    super.dispose();
  }

  Future<void> _saveProfile() async {
    setState(() { _profileErr = null; _profileOk = null; });
    final api = ref.read(apiProvider).requireValue;
    final user = ref.read(sessionProvider);
    try {
      final updated = await api.updateProfile(
        name: _name.text.trim() != user?.name ? _name.text.trim() : null,
        email: _email.text.trim() != user?.email ? _email.text.trim() : null,
      );
      ref.read(sessionProvider.notifier).updateUser(updated);
      setState(() => _profileOk = 'Profile updated');
    } catch (e) {
      setState(() => _profileErr = '$e');
    }
  }

  Future<void> _savePassword() async {
    setState(() { _pwOk = null; _pwErr = null; });
    if (_newPw.text.length < 8) {
      setState(() => _pwErr = 'Password must be at least 8 characters');
      return;
    }
    if (_newPw.text != _confirmPw.text) {
      setState(() => _pwErr = "Passwords don't match");
      return;
    }
    final api = ref.read(apiProvider).requireValue;
    try {
      await api.changePassword(_currentPw.text, _newPw.text);
      setState(() {
        _pwOk = 'Password updated';
        _currentPw.clear(); _newPw.clear(); _confirmPw.clear();
      });
    } catch (e) {
      setState(() => _pwErr = '$e');
    }
  }

  Future<void> _deleteAccount() async {
    final ctl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete account'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('This cannot be undone. Enter your password to confirm.'),
            const SizedBox(height: 12),
            TextField(
              controller: ctl,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'Password'),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('Delete'),
          ),
        ],
      ),
    ) ?? false;
    if (!ok || ctl.text.isEmpty) return;
    final api = ref.read(apiProvider).requireValue;
    try {
      await api.deleteAccount(ctl.text);
      await ref.read(sessionProvider.notifier).signOut();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _signOut() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Sign out?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('Sign out'),
          ),
        ],
      ),
    ) ?? false;
    if (!ok) return;
    await ref.read(sessionProvider.notifier).signOut();
  }

  Widget _themeButton(ThemeMode2 mode, IconData icon, String label) {
    final current = ref.watch(themeModeProvider);
    final active = current == mode;
    final p = context.p;
    return Expanded(
      child: InkWell(
        onTap: () => ref.read(themeModeProvider.notifier).set(mode),
        borderRadius: BorderRadius.circular(8),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 10),
          decoration: BoxDecoration(
            color: active ? p.accentBg : p.bg,
            border: Border.all(color: active ? p.brand : p.border),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, color: active ? p.brand : p.muted, size: 18),
              const SizedBox(height: 4),
              Text(label, style: TextStyle(
                color: active ? p.brand : p.text,
                fontWeight: FontWeight.w600, fontSize: 12,
              )),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _card('Appearance', [
            Text('Theme', style: TextStyle(color: p.muted, fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 0.5)),
            const SizedBox(height: 8),
            Row(children: [
              _themeButton(ThemeMode2.light, LucideIcons.sun, 'Light'),
              const SizedBox(width: 8),
              _themeButton(ThemeMode2.dark, LucideIcons.moon, 'Dark'),
              const SizedBox(width: 8),
              _themeButton(ThemeMode2.system, LucideIcons.monitor, 'System'),
            ]),
          ]),
          const SizedBox(height: 16),
          _card('Profile', [
            TextField(controller: _name, decoration: const InputDecoration(labelText: 'Name')),
            const SizedBox(height: 10),
            TextField(controller: _email, decoration: const InputDecoration(labelText: 'Email'), keyboardType: TextInputType.emailAddress),
            if (_profileOk != null) ...[const SizedBox(height: 10), MessageBanner(message: _profileOk!, ok: true)],
            if (_profileErr != null) ...[const SizedBox(height: 10), MessageBanner(message: _profileErr!)],
            const SizedBox(height: 14),
            SizedBox(width: double.infinity, child: ElevatedButton(onPressed: _saveProfile, child: const Text('Save changes'))),
          ]),
          const SizedBox(height: 16),
          _card('Change password', [
            TextField(controller: _currentPw, decoration: const InputDecoration(labelText: 'Current password'), obscureText: true),
            const SizedBox(height: 10),
            TextField(controller: _newPw, decoration: const InputDecoration(labelText: 'New password'), obscureText: true),
            const SizedBox(height: 10),
            TextField(controller: _confirmPw, decoration: const InputDecoration(labelText: 'Confirm new password'), obscureText: true),
            if (_pwOk != null) ...[const SizedBox(height: 10), MessageBanner(message: _pwOk!, ok: true)],
            if (_pwErr != null) ...[const SizedBox(height: 10), MessageBanner(message: _pwErr!)],
            const SizedBox(height: 14),
            SizedBox(width: double.infinity, child: ElevatedButton(onPressed: _savePassword, child: const Text('Update password'))),
          ]),
          const SizedBox(height: 16),
          _card('Session', [
            SizedBox(
              width: double.infinity,
              child: OutlinedButton(
                onPressed: _signOut,
                style: OutlinedButton.styleFrom(
                  side: BorderSide(color: p.border),
                  foregroundColor: p.text,
                  padding: const EdgeInsets.symmetric(vertical: 12),
                ),
                child: const Text('Sign out'),
              ),
            ),
          ]),
          const SizedBox(height: 16),
          _card('Danger zone', [
            Text('Permanently delete your account and all files. This cannot be undone.',
                style: TextStyle(color: p.muted, fontSize: 13)),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton(
                onPressed: _deleteAccount,
                style: OutlinedButton.styleFrom(
                  side: BorderSide(color: p.errFg),
                  foregroundColor: p.danger,
                  backgroundColor: p.errBg,
                  padding: const EdgeInsets.symmetric(vertical: 12),
                ),
                child: const Text('Delete account'),
              ),
            ),
          ], danger: true),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  Widget _card(String title, List<Widget> children, {bool danger = false}) {
    final p = context.p;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: p.panel,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: danger ? p.errBg : p.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: TextStyle(
            color: danger ? p.danger : p.text,
            fontSize: 16, fontWeight: FontWeight.w600,
          )),
          const SizedBox(height: 12),
          ...children,
        ],
      ),
    );
  }
}
