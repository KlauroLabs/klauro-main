package com.example;

import jakarta.persistence.*;
import java.util.List;

@Entity
public class Student {
    @Id @GeneratedValue
    private Long id;

    @ManyToMany
    private List<Course> courses;

    @OneToOne
    private Passport passport;

    @OneToMany(mappedBy = "student")
    private List<Enrollment> enrollments;
}
