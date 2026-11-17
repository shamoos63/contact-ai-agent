import 'package:flutter/material.dart';

class AppColors {
  static const bg = Color(0xFF070A14);
  static const bg2 = Color(0xFF0D1324);
  static const card = Color(0x0FFFFFFF);
  static const cardBorder = Color(0x1AFFFFFF);
  static const cyan = Color(0xFF22D3EE);
  static const violet = Color(0xFF8B5CF6);
  static const pink = Color(0xFFEC4899);
  static const green = Color(0xFF34D399);
  static const amber = Color(0xFFFBBF24);
  static const red = Color(0xFFF87171);
  static const text = Color(0xFFE8ECF8);
  static const muted = Color(0xFF8A93B0);

  static const accent = LinearGradient(colors: [cyan, violet], begin: Alignment.topLeft, end: Alignment.bottomRight);
}

ThemeData buildTheme() {
  final base = ThemeData(brightness: Brightness.dark, useMaterial3: true);
  final scheme = ColorScheme.fromSeed(seedColor: AppColors.violet, brightness: Brightness.dark).copyWith(
    primary: AppColors.cyan,
    secondary: AppColors.violet,
    surface: AppColors.bg2,
    error: AppColors.red,
  );
  return base.copyWith(
    colorScheme: scheme,
    scaffoldBackgroundColor: AppColors.bg,
    textTheme: base.textTheme.apply(bodyColor: AppColors.text, displayColor: AppColors.text),
    appBarTheme: const AppBarTheme(backgroundColor: Colors.transparent, elevation: 0, scrolledUnderElevation: 0, centerTitle: false),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppColors.card,
      hintStyle: const TextStyle(color: AppColors.muted),
      labelStyle: const TextStyle(color: AppColors.muted),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: AppColors.cardBorder)),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: AppColors.cardBorder)),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: AppColors.cyan, width: 1.2)),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: AppColors.bg2.withValues(alpha: 0.92),
      indicatorColor: AppColors.violet.withValues(alpha: 0.25),
      labelTextStyle: WidgetStateProperty.all(const TextStyle(fontSize: 12, color: AppColors.muted)),
      iconTheme: WidgetStateProperty.resolveWith((s) => IconThemeData(color: s.contains(WidgetState.selected) ? AppColors.cyan : AppColors.muted)),
    ),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? Colors.white : AppColors.muted),
      trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? AppColors.violet : AppColors.card),
    ),
    snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating, backgroundColor: AppColors.bg2, contentTextStyle: TextStyle(color: AppColors.text)),
    dividerColor: AppColors.cardBorder,
  );
}

/// A soft glass card used across the app.
class Glass extends StatelessWidget {
  const Glass({super.key, required this.child, this.padding = const EdgeInsets.all(16), this.radius = 20, this.onTap, this.onLongPress, this.glow});
  final Widget child;
  final EdgeInsets padding;
  final double radius;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final Color? glow;

  @override
  Widget build(BuildContext context) {
    final box = Container(
      padding: padding,
      decoration: BoxDecoration(
        // A highlighted card gets a tinted fill and border (a shadow would show through the glass).
        color: glow?.withValues(alpha: 0.10) ?? AppColors.card,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: glow?.withValues(alpha: 0.5) ?? AppColors.cardBorder),
      ),
      // Its own Material, so list rows inside the card keep their tap ripple.
      child: Material(type: MaterialType.transparency, child: child),
    );
    if (onTap == null && onLongPress == null) return box;
    return Material(color: Colors.transparent, child: InkWell(borderRadius: BorderRadius.circular(radius), onTap: onTap, onLongPress: onLongPress, child: box));
  }
}

/// The app's background: deep navy with two faint coloured glows.
class AgentBackground extends StatelessWidget {
  const AgentBackground({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Stack(children: [
      const Positioned.fill(child: ColoredBox(color: AppColors.bg)),
      Positioned(
        top: -160,
        left: -120,
        child: _glow(AppColors.violet, 380),
      ),
      Positioned(
        bottom: -200,
        right: -140,
        child: _glow(AppColors.cyan, 420),
      ),
      Positioned.fill(child: child),
    ]);
  }

  Widget _glow(Color c, double size) => IgnorePointer(
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(shape: BoxShape.circle, gradient: RadialGradient(colors: [c.withValues(alpha: 0.22), c.withValues(alpha: 0)])),
        ),
      );
}

class GradientText extends StatelessWidget {
  const GradientText(this.text, {super.key, this.style});
  final String text;
  final TextStyle? style;
  @override
  Widget build(BuildContext context) => ShaderMask(
        shaderCallback: (r) => AppColors.accent.createShader(r),
        child: Text(text, style: (style ?? const TextStyle()).copyWith(color: Colors.white)),
      );
}

class GradientButton extends StatelessWidget {
  const GradientButton({super.key, required this.label, required this.onPressed, this.icon, this.busy = false});
  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !busy;
    return Opacity(
      opacity: enabled ? 1 : 0.6,
      child: Container(
        height: 52,
        decoration: BoxDecoration(gradient: AppColors.accent, borderRadius: BorderRadius.circular(16), boxShadow: [
          BoxShadow(color: AppColors.violet.withValues(alpha: 0.35), blurRadius: 20, offset: const Offset(0, 6)),
        ]),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(16),
            onTap: enabled ? onPressed : null,
            child: Center(
              child: busy
                  ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.4, color: Colors.white))
                  : Row(mainAxisSize: MainAxisSize.min, children: [
                      if (icon != null) ...[Icon(icon, color: Colors.white, size: 20), const SizedBox(width: 8)],
                      Text(label, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 16)),
                    ]),
            ),
          ),
        ),
      ),
    );
  }
}

void showError(BuildContext context, Object e) {
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString()), backgroundColor: const Color(0xFF3A1420)));
}

void showInfo(BuildContext context, String text) {
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
}

/// Right-to-left for Arabic text, left-to-right otherwise.
TextDirection directionOf(String text) =>
    RegExp(r'[؀-ۿ]').hasMatch(text.characters.take(40).toString()) ? TextDirection.rtl : TextDirection.ltr;
