import 'package:flutter/widgets.dart';
import 'package:lucide_icons/lucide_icons.dart';

String formatBytes(int b) {
  if (b < 1024) return '$b B';
  if (b < 1024 * 1024) return '${(b / 1024).toStringAsFixed(1)} KB';
  if (b < 1024 * 1024 * 1024) return '${(b / (1024 * 1024)).toStringAsFixed(1)} MB';
  return '${(b / (1024 * 1024 * 1024)).toStringAsFixed(2)} GB';
}

IconData iconForMime(String mime) {
  if (mime.startsWith('image/')) return LucideIcons.fileImage;
  if (mime.startsWith('video/')) return LucideIcons.fileVideo;
  if (mime.startsWith('audio/')) return LucideIcons.fileAudio;
  if (mime.contains('pdf')) return LucideIcons.fileText;
  if (mime.contains('zip') || mime.contains('compressed') || mime.contains('x-tar') || mime.contains('gzip')) {
    return LucideIcons.fileArchive;
  }
  if (mime.contains('javascript') ||
      mime.contains('typescript') ||
      mime.contains('json') ||
      mime.contains('xml') ||
      mime.contains('x-sh')) {
    return LucideIcons.fileCode;
  }
  if (mime.startsWith('text/')) return LucideIcons.fileText;
  return LucideIcons.file;
}

enum PreviewKind { image, video, audio, pdf, text, other }

PreviewKind previewKindFor(String mime) {
  if (mime.startsWith('image/')) return PreviewKind.image;
  if (mime.startsWith('video/')) return PreviewKind.video;
  if (mime.startsWith('audio/')) return PreviewKind.audio;
  if (mime == 'application/pdf') return PreviewKind.pdf;
  if (mime.startsWith('text/') ||
      mime.contains('json') ||
      mime.contains('xml') ||
      mime.contains('javascript') ||
      mime.contains('typescript')) return PreviewKind.text;
  return PreviewKind.other;
}

String relativeDate(DateTime d) {
  final now = DateTime.now();
  final diff = now.difference(d);
  if (diff.inSeconds < 60) return 'just now';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
  if (diff.inHours < 24) return '${diff.inHours}h ago';
  if (diff.inDays < 7) return '${diff.inDays}d ago';
  return '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
}
