import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../state.dart';
import '../theme.dart';

class AuthScreen extends ConsumerStatefulWidget {
  const AuthScreen({super.key});

  @override
  ConsumerState<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends ConsumerState<AuthScreen> {
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _signup = false;
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() { _error = null; _busy = true; });
    try {
      final session = ref.read(sessionProvider.notifier);
      if (_signup) {
        await session.signUp(_name.text.trim(), _email.text.trim(), _password.text);
      } else {
        await session.signIn(_email.text.trim(), _password.text);
      }
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('Stohr',
                    style: TextStyle(color: p.brand, fontSize: 40, fontWeight: FontWeight.w800)),
                const SizedBox(height: 6),
                Text(
                  _signup ? 'Create your account' : 'Sign in to your cloud storage',
                  style: TextStyle(color: p.muted, fontSize: 14),
                ),
                const SizedBox(height: 28),
                if (_error != null) ...[
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: p.errBg,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: p.errFg),
                    ),
                    child: Text(_error!, style: TextStyle(color: p.errFg, fontSize: 13)),
                  ),
                  const SizedBox(height: 12),
                ],
                if (_signup)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: TextField(
                      controller: _name,
                      decoration: const InputDecoration(labelText: 'Name'),
                      textInputAction: TextInputAction.next,
                      textCapitalization: TextCapitalization.words,
                    ),
                  ),
                TextField(
                  controller: _email,
                  decoration: const InputDecoration(labelText: 'Email'),
                  keyboardType: TextInputType.emailAddress,
                  autocorrect: false,
                  textInputAction: TextInputAction.next,
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _password,
                  decoration: const InputDecoration(labelText: 'Password'),
                  obscureText: true,
                  textInputAction: TextInputAction.go,
                  onSubmitted: (_) => _submit(),
                ),
                const SizedBox(height: 20),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: _busy ? null : _submit,
                    child: _busy
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                          )
                        : Text(_signup ? 'Create account' : 'Sign in'),
                  ),
                ),
                const SizedBox(height: 20),
                TextButton(
                  onPressed: () => setState(() => _signup = !_signup),
                  child: Text(
                    _signup
                        ? 'Already have an account? Sign in'
                        : "Don't have an account? Sign up",
                    style: TextStyle(color: p.brand),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
