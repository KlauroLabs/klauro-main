package com.example;

import jakarta.persistence.*;

@Entity
public class User {
    @Id @GeneratedValue
    private Long id;

    @OneToOne
    private Profile profile;
}
