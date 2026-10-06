import io.vertx.ext.web.Router;

public class MainVerticle {
    public void start(Router router) {
        router.get("/users").handler(this::listUsers);
        router.post("/users").handler(this::createUser);
    }

    private void listUsers(Object ctx) {}
    private void createUser(Object ctx) {}
}
