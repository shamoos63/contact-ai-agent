import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme.dart';

enum OrbState { idle, listening, thinking, speaking, offline }

/// The agent's "face": a living orb of light. It breathes when idle, swirls while thinking,
/// pulses with your voice while listening and ripples while it speaks.
class AgentOrb extends StatefulWidget {
  const AgentOrb({super.key, this.state = OrbState.idle, this.level = 0, this.size = 180});
  final OrbState state;
  final double level; // 0..1 microphone level while listening
  final double size;

  @override
  State<AgentOrb> createState() => _AgentOrbState();
}

class _AgentOrbState extends State<AgentOrb> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 12))..repeat();
  double _smoothLevel = 0;

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          _smoothLevel += (widget.level - _smoothLevel) * 0.25;
          return CustomPaint(
            size: Size.square(widget.size),
            painter: _OrbPainter(t: _c.value, state: widget.state, level: _smoothLevel),
          );
        },
      ),
    );
  }
}

class _OrbPainter extends CustomPainter {
  _OrbPainter({required this.t, required this.state, required this.level});
  final double t;
  final OrbState state;
  final double level;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final r = size.width / 2;
    final tau = math.pi * 2;
    final speed = switch (state) { OrbState.thinking => 6.0, OrbState.speaking => 3.0, OrbState.listening => 2.0, _ => 1.0 };
    final phase = t * tau * speed;

    double breathe = switch (state) {
      OrbState.idle => 0.04 * math.sin(t * tau * 3),
      OrbState.listening => 0.06 + level * 0.18,
      OrbState.speaking => 0.05 * math.sin(t * tau * 24).abs(),
      OrbState.thinking => 0.03 * math.sin(t * tau * 12),
      OrbState.offline => 0,
    };
    final coreR = r * (0.62 + breathe);

    final colors = state == OrbState.offline
        ? [const Color(0xFF4B5563), const Color(0xFF1F2937)]
        : [AppColors.cyan, AppColors.violet, AppColors.pink];

    // Outer halo.
    canvas.drawCircle(
      c,
      r,
      Paint()
        ..shader = RadialGradient(colors: [colors.first.withValues(alpha: 0.28), colors[1].withValues(alpha: 0.10), Colors.transparent], stops: const [0.35, 0.7, 1])
            .createShader(Rect.fromCircle(center: c, radius: r)),
    );

    // Ripples while speaking or listening.
    if (state == OrbState.speaking || state == OrbState.listening) {
      for (var i = 0; i < 3; i++) {
        final p = (t * speed * 4 + i / 3) % 1.0;
        canvas.drawCircle(
          c,
          coreR + (r - coreR) * p,
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2
            ..color = colors.first.withValues(alpha: (1 - p) * 0.45),
        );
      }
    }

    // Core with drifting colour blobs.
    canvas.save();
    canvas.clipPath(Path()..addOval(Rect.fromCircle(center: c, radius: coreR)));
    canvas.drawCircle(c, coreR, Paint()..color = const Color(0xFF0B1022));
    for (var i = 0; i < 3; i++) {
      final a = phase + i * tau / 3;
      final off = Offset(math.cos(a), math.sin(a * 1.3)) * coreR * 0.38;
      final blobR = coreR * (0.85 + 0.1 * math.sin(phase * 0.7 + i));
      canvas.drawCircle(
        c + off,
        blobR,
        Paint()
          ..shader = RadialGradient(colors: [colors[i % colors.length].withValues(alpha: 0.85), colors[i % colors.length].withValues(alpha: 0)])
              .createShader(Rect.fromCircle(center: c + off, radius: blobR))
          ..blendMode = BlendMode.plus,
      );
    }
    // Thinking: a bright arc running around the edge.
    if (state == OrbState.thinking) {
      canvas.drawArc(
        Rect.fromCircle(center: c, radius: coreR * 0.92),
        phase * 1.5,
        math.pi * 0.7,
        false,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 3
          ..strokeCap = StrokeCap.round
          ..shader = SweepGradient(colors: [Colors.white.withValues(alpha: 0), Colors.white.withValues(alpha: 0.9)], transform: GradientRotation(phase * 1.5))
              .createShader(Rect.fromCircle(center: c, radius: coreR)),
      );
    }
    // Glassy highlight.
    canvas.drawCircle(
      c + Offset(-coreR * 0.3, -coreR * 0.35),
      coreR * 0.55,
      Paint()
        ..shader = RadialGradient(colors: [Colors.white.withValues(alpha: 0.22), Colors.white.withValues(alpha: 0)])
            .createShader(Rect.fromCircle(center: c + Offset(-coreR * 0.3, -coreR * 0.35), radius: coreR * 0.55)),
    );
    canvas.restore();

    // Rim.
    canvas.drawCircle(
      c,
      coreR,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.2
        ..color = Colors.white.withValues(alpha: 0.18),
    );
  }

  @override
  bool shouldRepaint(_OrbPainter old) => true;
}
