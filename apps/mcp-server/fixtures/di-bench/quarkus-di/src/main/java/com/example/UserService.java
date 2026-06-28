package com.example;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;

@ApplicationScoped
public class UserService {
    @Inject
    UserRepository userRepository;

    public java.util.List<String> findAll() { return userRepository.all(); }
}
