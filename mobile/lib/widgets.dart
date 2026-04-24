import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'models.dart';
import 'theme.dart';
import 'utils.dart';

class FolderRow extends StatelessWidget {
  final Folder folder;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final Widget? trailing;

  const FolderRow({
    super.key,
    required this.folder,
    this.onTap,
    this.onLongPress,
    this.trailing,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Material(
      color: p.panel,
      child: InkWell(
        onTap: onTap,
        onLongPress: onLongPress,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: p.border, width: 0.5)),
          ),
          child: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: p.accentBg,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(LucideIcons.folder, color: p.brand, size: 22),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      folder.name,
                      style: TextStyle(color: p.text, fontSize: 15, fontWeight: FontWeight.w500),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    Text('Folder', style: TextStyle(color: p.muted, fontSize: 12)),
                  ],
                ),
              ),
              if (trailing != null) trailing!,
            ],
          ),
        ),
      ),
    );
  }
}

class FileRow extends StatelessWidget {
  final FileItem file;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final Widget? trailing;
  final String? metaOverride;

  const FileRow({
    super.key,
    required this.file,
    this.onTap,
    this.onLongPress,
    this.trailing,
    this.metaOverride,
  });

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Material(
      color: p.panel,
      child: InkWell(
        onTap: onTap,
        onLongPress: onLongPress,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: p.border, width: 0.5)),
          ),
          child: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: p.accentBg,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(iconForMime(file.mime), color: p.brand, size: 22),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      file.name,
                      style: TextStyle(color: p.text, fontSize: 15, fontWeight: FontWeight.w500),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    Row(
                      children: [
                        Text(
                          metaOverride ?? formatBytes(file.size),
                          style: TextStyle(color: p.muted, fontSize: 12),
                        ),
                        if (file.version > 1) ...[
                          const SizedBox(width: 8),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                            decoration: BoxDecoration(
                              color: p.brand,
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Text(
                              'v${file.version}',
                              style: TextStyle(
                                color: p.brandFg,
                                fontSize: 10,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
              if (trailing != null) trailing!,
            ],
          ),
        ),
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? subtitle;

  const EmptyState({super.key, required this.icon, required this.title, this.subtitle});

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, color: p.border, size: 72),
            const SizedBox(height: 14),
            Text(
              title,
              style: TextStyle(color: p.text, fontSize: 16, fontWeight: FontWeight.w500),
              textAlign: TextAlign.center,
            ),
            if (subtitle != null) ...[
              const SizedBox(height: 6),
              Text(
                subtitle!,
                style: TextStyle(color: p.muted, fontSize: 13),
                textAlign: TextAlign.center,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class MessageBanner extends StatelessWidget {
  final String message;
  final bool ok;
  const MessageBanner({super.key, required this.message, this.ok = false});

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final bg = ok ? p.okBg : p.errBg;
    final fg = ok ? p.okFg : p.errFg;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: fg),
      ),
      child: Text(message, style: TextStyle(color: fg, fontSize: 13)),
    );
  }
}
