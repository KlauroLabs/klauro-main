plugins {
    id("org.springframework.boot") version "3.2.0"
    id("io.spring.dependency-management") version "1.1.4"
    java
}

dependencies {
    implementation(project(":packages:common-lib"))
    implementation("org.springframework.boot:spring-boot-starter-web")
}
