import 'package:shelf/shelf.dart';
import 'package:shelf_router/shelf_router.dart';

final _users = Router()
  ..get('/users', _listUsers)
  ..get('/users/<id>', _getUser)
  ..post('/users', _createUser);

Router buildRootRouter() {
  final api = Router();
  api.mount('/', _users.call);

  final root = Router();
  root.get('/health', _health);
  root.mount('/api/', api.call);
  return root;
}

Response _health(Request request) => Response.ok('ok');
Response _listUsers(Request request) => Response.ok('list');
Response _getUser(Request request, String id) => Response.ok(id);
Response _createUser(Request request) => Response.ok('created');
