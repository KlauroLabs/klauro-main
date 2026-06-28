import 'account.dart';
class Service {
  void persist(Account a) {
    a.save();
  }
}
