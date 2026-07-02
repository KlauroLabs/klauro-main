FROM eclipse-temurin:21-jdk as builder
WORKDIR /app
COPY . .
RUN ./gradlew :apps:billing-service:bootJar

FROM eclipse-temurin:21-jre
COPY --from=builder /app/apps/billing-service/build/libs/billing-service.jar /app/billing-service.jar
EXPOSE 8081
ENTRYPOINT ["java", "-jar", "/app/billing-service.jar"]
