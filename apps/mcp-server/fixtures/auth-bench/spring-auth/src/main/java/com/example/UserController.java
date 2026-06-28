package com.example;

import org.springframework.web.bind.annotation.*;
import org.springframework.security.access.prepost.PreAuthorize;

@RestController
@RequestMapping("/users")
public class UserController {

    @GetMapping
    public String list() {
        return "all users";
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping
    public String create(@RequestBody String body) {
        return "created";
    }

    @DeleteMapping("/{id}")
    @PreAuthorize("hasRole('ADMIN')")
    public String remove(@PathVariable Long id) {
        return "deleted";
    }
}
