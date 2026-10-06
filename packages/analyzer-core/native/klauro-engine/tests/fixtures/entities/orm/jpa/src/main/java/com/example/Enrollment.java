package com.example;

import jakarta.persistence.*;

@Entity
public class Enrollment {
    @Id
    private Long id;

    @ManyToOne
    private Student student;
}
