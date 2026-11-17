import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// One chat message. Owner (or customer) on the right, the agent on the left.
class MessageBubble extends StatelessWidget {
  const MessageBubble({super.key, required this.m, required this.mine, this.onPlay, this.playing = false, this.agentLabel = 'Agent', this.otherInitial});
  final Message m;
  final bool mine;
  final VoidCallback? onPlay;
  final bool playing;
  final String agentLabel;

  /// In a customer chat the left side is the customer: show their initial instead of the agent's mark.
  final String? otherInitial;

  @override
  Widget build(BuildContext context) {
    if (m.direction == 'note') {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(color: AppColors.amber.withValues(alpha: 0.10), borderRadius: BorderRadius.circular(12)),
            child: Text(m.text, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.amber, fontSize: 12)),
          ),
        ),
      );
    }
    final text = m.visibleText;
    final photo = m.photoDescription;
    final maxW = MediaQuery.of(context).size.width * 0.8;
    final bubble = Container(
      constraints: BoxConstraints(maxWidth: maxW),
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 8),
      decoration: BoxDecoration(
        gradient: mine ? LinearGradient(colors: [AppColors.violet.withValues(alpha: 0.55), AppColors.cyan.withValues(alpha: 0.35)]) : null,
        color: mine ? null : AppColors.card,
        border: Border.all(color: mine ? Colors.white.withValues(alpha: 0.12) : AppColors.cardBorder),
        borderRadius: BorderRadius.only(
          topLeft: const Radius.circular(18),
          topRight: const Radius.circular(18),
          bottomLeft: Radius.circular(mine ? 18 : 4),
          bottomRight: Radius.circular(mine ? 4 : 18),
        ),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        if (m.image != null) ...[
          ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: Image.network(Api.instance.media(m.image!), headers: Api.instance.authHeaders, height: 180, fit: BoxFit.cover,
                errorBuilder: (_, __, ___) => const SizedBox(height: 60, child: Center(child: Icon(Icons.broken_image_rounded, color: AppColors.muted)))),
          ),
          const SizedBox(height: 6),
        ],
        if (m.audio != null)
          InkWell(
            onTap: onPlay,
            borderRadius: BorderRadius.circular(20),
            child: Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Container(
                  width: 34,
                  height: 34,
                  decoration: const BoxDecoration(shape: BoxShape.circle, gradient: AppColors.accent),
                  child: Icon(playing ? Icons.stop_rounded : Icons.play_arrow_rounded, color: Colors.white, size: 20),
                ),
                const SizedBox(width: 8),
                _Wave(active: playing),
                const SizedBox(width: 8),
                Text(m.meta['duration'] != null ? '${m.meta['duration']}s' : (m.meta['spoken'] == true ? 'Spoken reply' : 'Voice note'),
                    style: const TextStyle(color: AppColors.muted, fontSize: 12)),
              ]),
            ),
          ),
        if (text.isNotEmpty && !(m.audio != null && text == '🎤 Voice note'))
          Directionality(
            textDirection: directionOf(text),
            child: SelectableText(text, style: const TextStyle(fontSize: 15, height: 1.35)),
          ),
        if (photo != null && !mine)
          Padding(padding: const EdgeInsets.only(top: 4), child: Text('📷 $photo', style: const TextStyle(color: AppColors.muted, fontSize: 12))),
        if (photo != null && mine && text.isEmpty)
          const Text('📷 Photo', style: TextStyle(color: AppColors.muted, fontSize: 12)),
        const SizedBox(height: 4),
        Row(mainAxisSize: MainAxisSize.min, children: [
          if (m.error != null) ...[const Icon(Icons.error_outline_rounded, size: 13, color: AppColors.red), const SizedBox(width: 4)],
          Text(_time(m.createdAt), style: TextStyle(color: Colors.white.withValues(alpha: 0.45), fontSize: 11)),
        ]),
      ]),
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: mine ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          if (!mine) ...[
            Container(
              width: 26,
              height: 26,
              margin: const EdgeInsets.only(right: 6, bottom: 2),
              decoration: otherInitial == null
                  ? const BoxDecoration(shape: BoxShape.circle, gradient: AppColors.accent)
                  : BoxDecoration(shape: BoxShape.circle, color: AppColors.violet.withValues(alpha: 0.3)),
              child: otherInitial == null
                  ? const Icon(Icons.auto_awesome_rounded, size: 14, color: Colors.white)
                  : Center(child: Text(otherInitial!, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600))),
            ),
          ],
          Flexible(child: bubble),
        ],
      ),
    );
  }

  static String _time(DateTime d) {
    final now = DateTime.now();
    final hm = '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    if (d.year == now.year && d.month == now.month && d.day == now.day) return hm;
    return '${d.day}/${d.month} $hm';
  }
}

class _Wave extends StatefulWidget {
  const _Wave({required this.active});
  final bool active;
  @override
  State<_Wave> createState() => _WaveState();
}

class _WaveState extends State<_Wave> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..repeat(reverse: true);
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    const bars = [0.4, 0.8, 0.55, 1.0, 0.65, 0.9, 0.45, 0.7, 0.5];
    return AnimatedBuilder(
      animation: _c,
      builder: (_, __) => Row(
        children: [
          for (var i = 0; i < bars.length; i++)
            Container(
              width: 3,
              height: 6 + 16 * (widget.active ? (bars[i] * (0.5 + 0.5 * ((_c.value + i * 0.13) % 1))) : bars[i] * 0.6),
              margin: const EdgeInsets.symmetric(horizontal: 1.2),
              decoration: BoxDecoration(color: AppColors.cyan.withValues(alpha: 0.8), borderRadius: BorderRadius.circular(2)),
            ),
        ],
      ),
    );
  }
}
