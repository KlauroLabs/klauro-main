import io.ktor.server.application.*
import io.ktor.server.routing.*
import io.ktor.server.response.*

fun Application.module() {
    routing {
        get("/users") {
            call.respondText("all users")
        }
        post("/users") {
            call.respondText("created")
        }
        delete("/users/{id}") {
            call.respondText("deleted")
        }
    }
}
