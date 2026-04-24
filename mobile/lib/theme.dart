import 'package:flutter/material.dart';

class AppPalette {
  final Color bg;
  final Color panel;
  final Color border;
  final Color text;
  final Color muted;
  final Color brand;
  final Color brandFg;
  final Color hover;
  final Color danger;
  final Color accentBg;
  final Color okBg;
  final Color okFg;
  final Color errBg;
  final Color errFg;

  const AppPalette({
    required this.bg,
    required this.panel,
    required this.border,
    required this.text,
    required this.muted,
    required this.brand,
    required this.brandFg,
    required this.hover,
    required this.danger,
    required this.accentBg,
    required this.okBg,
    required this.okFg,
    required this.errBg,
    required this.errFg,
  });

  static const light = AppPalette(
    bg: Color(0xFFF6F8FB),
    panel: Color(0xFFFFFFFF),
    border: Color(0xFFE3E8EF),
    text: Color(0xFF1A2B42),
    muted: Color(0xFF6B7A90),
    brand: Color(0xFF0061D5),
    brandFg: Color(0xFFFFFFFF),
    hover: Color(0xFFEEF3FB),
    danger: Color(0xFFD64545),
    accentBg: Color(0xFFEAF2FC),
    okBg: Color(0xFFE7F5EA),
    okFg: Color(0xFF1B6B37),
    errBg: Color(0xFFFDE9E9),
    errFg: Color(0xFFD64545),
  );

  static const dark = AppPalette(
    bg: Color(0xFF0B1220),
    panel: Color(0xFF151C2C),
    border: Color(0xFF273348),
    text: Color(0xFFE2E8F0),
    muted: Color(0xFF94A3B8),
    brand: Color(0xFF3B82F6),
    brandFg: Color(0xFFFFFFFF),
    hover: Color(0xFF1D2840),
    danger: Color(0xFFF87171),
    accentBg: Color(0x1F3B82F6),
    okBg: Color(0x2D1B6B37),
    okFg: Color(0xFF86EFAC),
    errBg: Color(0x26EF4444),
    errFg: Color(0xFFFCA5A5),
  );
}

ThemeData buildTheme(AppPalette p, {required bool dark}) {
  final base = dark ? ThemeData.dark(useMaterial3: true) : ThemeData.light(useMaterial3: true);
  return base.copyWith(
    scaffoldBackgroundColor: p.bg,
    colorScheme: base.colorScheme.copyWith(
      primary: p.brand,
      onPrimary: p.brandFg,
      surface: p.panel,
      onSurface: p.text,
      error: p.danger,
      secondary: p.brand,
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: p.panel,
      foregroundColor: p.text,
      elevation: 0,
      surfaceTintColor: p.panel,
      titleTextStyle: TextStyle(color: p.text, fontSize: 17, fontWeight: FontWeight.w600),
    ),
    cardTheme: CardThemeData(
      color: p.panel,
      elevation: 0,
      shape: RoundedRectangleBorder(
        side: BorderSide(color: p.border),
        borderRadius: BorderRadius.circular(10),
      ),
    ),
    dividerColor: p.border,
    iconTheme: IconThemeData(color: p.text),
    textTheme: base.textTheme.apply(bodyColor: p.text, displayColor: p.text),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: p.bg,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(color: p.border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(color: p.border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(color: p.brand, width: 2),
      ),
      labelStyle: TextStyle(color: p.muted, fontSize: 13),
      hintStyle: TextStyle(color: p.muted),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: p.brand,
        foregroundColor: p.brandFg,
        elevation: 0,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
      ),
    ),
    bottomNavigationBarTheme: BottomNavigationBarThemeData(
      backgroundColor: p.panel,
      selectedItemColor: p.brand,
      unselectedItemColor: p.muted,
      type: BottomNavigationBarType.fixed,
      elevation: 0,
    ),
  );
}

extension PaletteContext on BuildContext {
  AppPalette get p =>
      Theme.of(this).brightness == Brightness.dark ? AppPalette.dark : AppPalette.light;
}
