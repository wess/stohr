import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:stohrapp/login/index.dart';

void main() {
  testWidgets('Login screen renders', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: LoginScreen()));
    expect(find.text('Sign in'), findsOneWidget);
    expect(find.byType(TextFormField), findsAtLeast(2));
  });
}
