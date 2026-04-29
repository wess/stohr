import 'package:stohr/stohr.dart';
import '../config/index.dart';
import '../keychain/index.dart';

class AuthError implements Exception {
  final String message;
  AuthError(this.message);
  @override
  String toString() => message;
}

/// Result of [signIn]. Either we got a [User] (full sign-in) or the user has
/// MFA enabled and the caller must finish via [completeMfa].
sealed class SignInOutcome {
  const SignInOutcome();
}

class SignedIn extends SignInOutcome {
  final User user;
  const SignedIn(this.user);
}

class MfaRequired extends SignInOutcome {
  final String mfaToken;
  const MfaRequired(this.mfaToken);
}

Future<SignInOutcome> signIn({
  required StohrConfig config,
  required String identity,
  required String password,
}) async {
  final client = StohrClient(baseUrl: config.serverUrl);
  try {
    final res = await client.login(identity, password);
    if (res is MfaChallenge) {
      return MfaRequired(res.mfaToken);
    }
    final auth = res as AuthResult;
    await setSecret('token', auth.token);
    return SignedIn(auth.user);
  } on StohrError catch (e) {
    throw AuthError(e.message);
  } finally {
    client.close();
  }
}

Future<User> completeMfa({
  required StohrConfig config,
  required String mfaToken,
  String? code,
  String? backupCode,
}) async {
  final client = StohrClient(baseUrl: config.serverUrl);
  try {
    final res = await client.loginMfa(
      mfaToken: mfaToken,
      code: code,
      backupCode: backupCode,
    );
    await setSecret('token', res.token);
    return res.user;
  } on StohrError catch (e) {
    throw AuthError(e.message);
  } finally {
    client.close();
  }
}

Future<String?> loadToken() => getSecret('token');

Future<void> clearToken() => deleteSecret('token');
