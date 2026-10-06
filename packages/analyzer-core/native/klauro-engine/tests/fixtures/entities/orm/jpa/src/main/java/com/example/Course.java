package com.example;

import jakarta.persistence.*;
import java.util.Set;

@Entity
public class Course {
    @Id
    private Long id;

    @ManyToMany(mappedBy = "courses")
    private Set<Student> students;
}
