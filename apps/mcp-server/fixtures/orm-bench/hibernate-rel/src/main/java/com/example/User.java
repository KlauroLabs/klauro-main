package com.example;

import jakarta.persistence.*;
import java.util.List;

@Entity
public class User {
    @Id
    @GeneratedValue
    private Long id;

    private String email;

    @OneToMany(mappedBy = "user")
    private List<Post> posts;
}
