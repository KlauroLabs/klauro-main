package com.example;

import io.vertx.core.AbstractVerticle;
import io.vertx.ext.web.Router;

public class MainVerticle extends AbstractVerticle {

    @Override
    public void start() {
        Router router = Router.router(vertx);

        router.get("/users").handler(this::listUsers);
        router.post("/users").handler(this::createUser);
        router.get("/users/:id").handler(this::getUser);

        vertx.createHttpServer().requestHandler(router).listen(8080);
    }

    private void listUsers(io.vertx.ext.web.RoutingContext ctx) {}
    private void createUser(io.vertx.ext.web.RoutingContext ctx) {}
    private void getUser(io.vertx.ext.web.RoutingContext ctx) {}
}
