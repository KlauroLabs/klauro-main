/// Minimal auth state used by the router's redirect guard.
class AuthService {
  AuthService._();
  static final AuthService instance = AuthService._();

  bool _loggedIn = false;
  bool get isLoggedIn => _loggedIn;

  void login() => _loggedIn = true;
  void logout() => _loggedIn = false;
}
