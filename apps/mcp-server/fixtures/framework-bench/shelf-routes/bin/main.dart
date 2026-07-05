import 'dart:io';

import 'package:shelf/shelf_io.dart' as io;

import '../lib/server.dart';

void main() async {
  final handler = buildRootRouter();
  final server = await io.serve(handler, InternetAddress.anyIPv4, 8080);
  print('Serving at http://${server.address.host}:${server.port}');
}
