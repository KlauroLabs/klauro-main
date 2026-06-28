package com.example;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/users")
public class UserController {

    @GetMapping
    public String list() {
        return "all users";
    }

    @PostMapping
    public String create(@RequestBody String body) {
        return "created";
    }

    @DeleteMapping("/{id}")
    public String remove(@PathVariable Long id) {
        return "deleted";
    }
}
