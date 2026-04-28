import 'package:flutter/material.dart';
import 'package:stohr/stohr.dart';
import '../api/index.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _form = GlobalKey<FormState>();
  final _identity = TextEditingController();
  final _password = TextEditingController();
  final _base = TextEditingController(text: session.baseUrl ?? '');
  final _mfaCode = TextEditingController();
  final _mfaBackup = TextEditingController();
  bool _busy = false;
  String? _error;
  bool _showServer = false;
  String? _mfaToken;
  bool _mfaUseBackup = false;

  @override
  void dispose() {
    _identity.dispose();
    _password.dispose();
    _base.dispose();
    _mfaCode.dispose();
    _mfaBackup.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await session.setBase(_base.text.trim());
      final res = await session.login(_identity.text.trim(), _password.text);
      if (res is MfaChallenge) {
        setState(() {
          _mfaToken = res.mfaToken;
          _mfaCode.clear();
          _mfaBackup.clear();
        });
      }
    } on StohrError catch (e) {
      setState(() => _error = e.message);
    } catch (e) {
      setState(() => _error = 'Connect failed: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _submitMfa() async {
    if (_mfaToken == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await session.completeMfa(
        mfaToken: _mfaToken!,
        code: _mfaUseBackup ? null : _mfaCode.text.trim(),
        backupCode: _mfaUseBackup ? _mfaBackup.text.trim() : null,
      );
    } on StohrError catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 360),
              child: Form(
                key: _form,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text('stohr',
                        textAlign: TextAlign.center,
                        style: theme.textTheme.displaySmall?.copyWith(
                          fontWeight: FontWeight.w700,
                          letterSpacing: -1,
                        )),
                    const SizedBox(height: 8),
                    Text('Your cloud.',
                        textAlign: TextAlign.center,
                        style: theme.textTheme.bodyMedium?.copyWith(color: theme.hintColor)),
                    const SizedBox(height: 32),
                    if (_mfaToken != null) ...[
                      Text('Two-factor required',
                          textAlign: TextAlign.center,
                          style: theme.textTheme.titleSmall),
                      const SizedBox(height: 8),
                      Text(
                        _mfaUseBackup
                            ? 'Enter one of your saved backup codes.'
                            : 'Enter the 6-digit code from your authenticator app.',
                        textAlign: TextAlign.center,
                        style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
                      ),
                      const SizedBox(height: 16),
                      if (_mfaUseBackup)
                        TextFormField(
                          controller: _mfaBackup,
                          autofocus: true,
                          autocorrect: false,
                          textCapitalization: TextCapitalization.none,
                          decoration: const InputDecoration(labelText: 'Backup code (xxxxx-xxxxx)'),
                          onFieldSubmitted: (_) => _submitMfa(),
                        )
                      else
                        TextFormField(
                          controller: _mfaCode,
                          autofocus: true,
                          keyboardType: TextInputType.number,
                          maxLength: 6,
                          decoration: const InputDecoration(labelText: '6-digit code'),
                          onFieldSubmitted: (_) => _submitMfa(),
                        ),
                      if (_error != null) ...[
                        const SizedBox(height: 8),
                        Text(_error!,
                            style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error)),
                      ],
                      const SizedBox(height: 12),
                      FilledButton(
                        onPressed: _busy ? null : _submitMfa,
                        child: _busy
                            ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                            : const Text('Verify'),
                      ),
                      TextButton(
                        onPressed: () => setState(() {
                          _mfaUseBackup = !_mfaUseBackup;
                          _error = null;
                        }),
                        child: Text(_mfaUseBackup ? 'Use authenticator code instead' : 'Use a backup code'),
                      ),
                      TextButton(
                        onPressed: () => setState(() {
                          _mfaToken = null;
                          _mfaCode.clear();
                          _mfaBackup.clear();
                          _error = null;
                        }),
                        child: const Text('Cancel'),
                      ),
                    ] else ...[
                      TextFormField(
                        controller: _identity,
                        autofillHints: const [AutofillHints.username, AutofillHints.email],
                        keyboardType: TextInputType.emailAddress,
                        autocorrect: false,
                        decoration: const InputDecoration(labelText: 'Email or username'),
                        validator: (v) => (v == null || v.trim().isEmpty) ? 'Required' : null,
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: _password,
                        autofillHints: const [AutofillHints.password],
                        obscureText: true,
                        decoration: const InputDecoration(labelText: 'Password'),
                        validator: (v) => (v == null || v.isEmpty) ? 'Required' : null,
                        onFieldSubmitted: (_) => _submit(),
                      ),
                      if (_showServer) ...[
                        const SizedBox(height: 12),
                        TextFormField(
                          controller: _base,
                          keyboardType: TextInputType.url,
                          autocorrect: false,
                          decoration: const InputDecoration(
                            labelText: 'Server URL',
                            helperText: 'e.g. https://stohr.io/api',
                          ),
                        ),
                      ],
                      if (_error != null) ...[
                        const SizedBox(height: 12),
                        Text(_error!,
                            style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error)),
                      ],
                      const SizedBox(height: 20),
                      FilledButton(
                        onPressed: _busy ? null : _submit,
                        child: _busy
                            ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                            : const Text('Sign in'),
                      ),
                      const SizedBox(height: 8),
                      TextButton(
                        onPressed: () => setState(() => _showServer = !_showServer),
                        child: Text(_showServer ? 'Hide server URL' : 'Use a different server'),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
