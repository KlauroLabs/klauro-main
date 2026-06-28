package com.example;

import jakarta.inject.Singleton;

@Singleton
public class UserService {
    private final UserRepository repo;

    public UserService(UserRepository repo) {
        this.repo = repo;
    }

    public java.util.List<String> findAll() { return repo.all(); }
}
