import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:stohr/stohr.dart';
import '../api/index.dart';

class FolderTile extends StatelessWidget {
  final Folder folder;
  final VoidCallback onTap;
  const FolderTile({super.key, required this.folder, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final isPhotos = folder.kind == 'photos';
    return ListTile(
      leading: Icon(isPhotos ? Icons.photo_library_outlined : Icons.folder_outlined,
          color: Theme.of(context).colorScheme.primary),
      title: Text(folder.name, overflow: TextOverflow.ellipsis),
      subtitle: isPhotos ? const Text('Photos') : null,
      trailing: const Icon(Icons.chevron_right, size: 20),
      onTap: onTap,
    );
  }
}

class FileTile extends StatelessWidget {
  final FileItem file;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  const FileTile({super.key, required this.file, required this.onTap, this.onLongPress});

  String _size(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    if (bytes < 1024 * 1024 * 1024) return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
    return '${(bytes / 1024 / 1024 / 1024).toStringAsFixed(2)} GB';
  }

  IconData _icon() {
    final m = file.mime;
    if (m.startsWith('image/')) return Icons.image_outlined;
    if (m.startsWith('video/')) return Icons.movie_outlined;
    if (m.startsWith('audio/')) return Icons.music_note_outlined;
    if (m.startsWith('text/') || m.contains('json') || m.contains('xml')) return Icons.description_outlined;
    if (m.contains('pdf')) return Icons.picture_as_pdf_outlined;
    if (m.contains('zip') || m.contains('tar')) return Icons.archive_outlined;
    return Icons.insert_drive_file_outlined;
  }

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: Icon(_icon(), color: Theme.of(context).hintColor),
      title: Text(file.name, overflow: TextOverflow.ellipsis),
      subtitle: Text(_size(file.size), style: Theme.of(context).textTheme.bodySmall),
      trailing: const Icon(Icons.more_horiz, size: 20),
      onTap: onTap,
      onLongPress: onLongPress,
    );
  }
}

class PhotoThumb extends StatelessWidget {
  final FileItem file;
  final VoidCallback onTap;
  const PhotoThumb({super.key, required this.file, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final url = '${api.baseUrl}/files/${file.id}/thumb';
    return GestureDetector(
      onTap: onTap,
      child: Container(
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(6),
        ),
        clipBehavior: Clip.antiAlias,
        child: CachedNetworkImage(
          imageUrl: url,
          httpHeaders: {if (api.token != null) 'authorization': 'Bearer ${api.token}'},
          fit: BoxFit.cover,
          placeholder: (_, _) => const Center(
            child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
          ),
          errorWidget: (_, _, _) => const Center(child: Icon(Icons.broken_image_outlined, size: 24)),
        ),
      ),
    );
  }
}
