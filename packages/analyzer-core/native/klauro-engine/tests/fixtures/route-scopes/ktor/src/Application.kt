import io.ktor.server.auth.*
import io.ktor.server.routing.*

fun Application.module() {
    routing {
        get("/users") {
            call.respondText("all")
        }
        authenticate("auth-jwt") {
            post("/users") {
                call.respondText("created")
            }
        }
    }
}
