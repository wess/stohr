import 'dart:io';
import 'package:flutter/material.dart';
import 'package:stohr/stohr.dart';
import '../api/index.dart';

enum UploadStatus { pending, running, done, failed }

class _UploadJob {
  final String path;
  UploadStatus status = UploadStatus.pending;
  String? error;
  _UploadJob(this.path);
  String get name => path.split(Platform.pathSeparator).last;
}

class UploadScreen extends StatefulWidget {
  final List<String> paths;
  final int? folderId;
  const UploadScreen({super.key, required this.paths, this.folderId});
  @override
  State<UploadScreen> createState() => _UploadScreenState();
}

class _UploadScreenState extends State<UploadScreen> {
  late final List<_UploadJob> _jobs = widget.paths.map((p) => _UploadJob(p)).toList();
  bool _running = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _start());
  }

  Future<void> _start() async {
    if (_running) return;
    setState(() => _running = true);
    for (final job in _jobs) {
      if (!mounted) return;
      setState(() => job.status = UploadStatus.running);
      try {
        final file = File(job.path);
        final bytes = await file.readAsBytes();
        await api.uploadFile(
          bytes: bytes,
          name: job.name,
          folderId: widget.folderId,
        );
        if (!mounted) return;
        setState(() => job.status = UploadStatus.done);
      } on StohrError catch (e) {
        if (!mounted) return;
        setState(() {
          job.status = UploadStatus.failed;
          job.error = e.message;
        });
      } catch (e) {
        if (!mounted) return;
        setState(() {
          job.status = UploadStatus.failed;
          job.error = e.toString();
        });
      }
    }
    if (!mounted) return;
    setState(() => _running = false);
  }

  @override
  Widget build(BuildContext context) {
    final done = _jobs.where((j) => j.status == UploadStatus.done).length;
    final failed = _jobs.where((j) => j.status == UploadStatus.failed).length;
    return Scaffold(
      appBar: AppBar(
        title: Text(_running ? 'Uploading $done/${_jobs.length}' : 'Upload complete'),
        actions: [
          if (!_running)
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Done'),
            ),
        ],
      ),
      body: ListView.separated(
        itemCount: _jobs.length,
        separatorBuilder: (_, _) => const Divider(height: 1),
        itemBuilder: (_, i) {
          final job = _jobs[i];
          return ListTile(
            leading: _statusIcon(job.status),
            title: Text(job.name, overflow: TextOverflow.ellipsis),
            subtitle: job.error != null
                ? Text(job.error!, style: const TextStyle(color: Colors.redAccent))
                : Text(_label(job.status)),
          );
        },
      ),
      bottomNavigationBar: !_running && failed > 0
          ? SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Text(
                  '$failed failed',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.redAccent),
                ),
              ),
            )
          : null,
    );
  }

  Widget _statusIcon(UploadStatus s) {
    switch (s) {
      case UploadStatus.pending:
        return const Icon(Icons.schedule, color: Colors.grey);
      case UploadStatus.running:
        return const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2));
      case UploadStatus.done:
        return const Icon(Icons.check_circle_outline, color: Colors.green);
      case UploadStatus.failed:
        return const Icon(Icons.error_outline, color: Colors.redAccent);
    }
  }

  String _label(UploadStatus s) {
    switch (s) {
      case UploadStatus.pending:
        return 'Waiting…';
      case UploadStatus.running:
        return 'Uploading…';
      case UploadStatus.done:
        return 'Done';
      case UploadStatus.failed:
        return 'Failed';
    }
  }
}
