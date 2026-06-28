import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'auth.dart';
import 'screens.dart';

/// App router. A top-level [redirect] sends unauthenticated users to /login,
/// so every route except the public login route sits behind auth.
final GoRouter appRouter = GoRouter(
  initialLocation: '/',
  redirect: (BuildContext context, GoRouterState state) {
    final bool loggedIn = AuthService.instance.isLoggedIn;
    final bool goingToLogin = state.matchedLocation == '/login';
    if (!loggedIn && !goingToLogin) return '/login';
    if (loggedIn && goingToLogin) return '/';
    return null;
  },
  routes: <RouteBase>[
    GoRoute(
      path: '/login',
      builder: (context, state) => const LoginScreen(),
    ),
    GoRoute(
      path: '/',
      builder: (context, state) => const HomeScreen(),
    ),
    GoRoute(
      path: '/users/:id',
      builder: (context, state) => UserDetailScreen(id: state.pathParameters['id']!),
      routes: <RouteBase>[
        GoRoute(
          path: 'edit',
          builder: (context, state) => const UserEditScreen(),
        ),
      ],
    ),
    ShellRoute(
      builder: (context, state, child) => DashboardShell(child: child),
      routes: <RouteBase>[
        GoRoute(
          path: '/dashboard',
          builder: (context, state) => const DashboardScreen(),
        ),
        GoRoute(
          path: '/settings',
          builder: (context, state) => const SettingsScreen(),
        ),
      ],
    ),
  ],
);
