package com.example;

import jakarta.persistence.*;
import java.util.Set;

@Entity
public class Student {
    @Id @GeneratedValue
    private Long id;

    @ManyToMany
    private Set<Course> courses;
}
