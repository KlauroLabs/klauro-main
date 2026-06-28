import 'package:flutter/material.dart';

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});
  @override
  Widget build(BuildContext context) => const Scaffold(body: Center(child: Text('Login')));
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});
  @override
  Widget build(BuildContext context) => const Scaffold(body: Center(child: Text('Home')));
}

class UserDetailScreen extends StatelessWidget {
  const UserDetailScreen({super.key, required this.id});
  final String id;
  @override
  Widget build(BuildContext context) => Scaffold(body: Center(child: Text('User $id')));
}

class UserEditScreen extends StatelessWidget {
  const UserEditScreen({super.key});
  @override
  Widget build(BuildContext context) => const Scaffold(body: Center(child: Text('Edit user')));
}

class DashboardShell extends StatelessWidget {
  const DashboardShell({super.key, required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => Scaffold(body: child);
}

class DashboardScreen extends StatelessWidget {
  const DashboardScreen({super.key});
  @override
  Widget build(BuildContext context) => const Scaffold(body: Center(child: Text('Dashboard')));
}

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});
  @override
  Widget build(BuildContext context) => const Scaffold(body: Center(child: Text('Settings')));
}
