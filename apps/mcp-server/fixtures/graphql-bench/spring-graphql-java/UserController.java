package com.example;

import org.springframework.graphql.data.method.annotation.Argument;
import org.springframework.graphql.data.method.annotation.MutationMapping;
import org.springframework.graphql.data.method.annotation.QueryMapping;
import org.springframework.stereotype.Controller;

import java.util.List;

@Controller
public class UserController {

    @QueryMapping
    public User user(@Argument String id) {
        return new User(id, null);
    }

    @QueryMapping
    public List<User> users() {
        return List.of();
    }

    @MutationMapping
    public User createUser(@Argument String email) {
        return new User(null, email);
    }
}
