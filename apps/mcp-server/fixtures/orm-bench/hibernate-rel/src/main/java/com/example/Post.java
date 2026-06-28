package com.example;

import jakarta.persistence.*;

@Entity
public class Post {
    @Id
    @GeneratedValue
    private Long id;

    private String title;

    @ManyToOne
    @JoinColumn(name = "user_id")
    private User user;
}
