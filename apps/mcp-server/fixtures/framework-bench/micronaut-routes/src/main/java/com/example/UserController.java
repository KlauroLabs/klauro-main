package com.example;

import io.micronaut.http.annotation.*;

@Controller("/users")
public class UserController {

    @Get
    public String list() {
        return "all users";
    }

    @Post
    public String create(@Body String body) {
        return "created";
    }

    @Delete("/{id}")
    public String remove(Long id) {
        return "deleted";
    }
}
