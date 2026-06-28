package com.example;

import jakarta.persistence.*;

@Entity
public class Profile {
    @Id @GeneratedValue
    private Long id;

    @OneToOne(mappedBy = "profile")
    private User user;
}
