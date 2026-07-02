FROM eclipse-temurin:21-jdk as builder
WORKDIR /app
COPY . .
RUN ./gradlew :apps:orders-service:bootJar

FROM eclipse-temurin:21-jre
COPY --from=builder /app/apps/orders-service/build/libs/orders-service.jar /app/orders-service.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/orders-service.jar"]
