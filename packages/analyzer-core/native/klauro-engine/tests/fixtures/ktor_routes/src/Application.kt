package shop

import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

fun Application.module() {
    routing {
        get("/health") {
            call.respondText("ok")
        }
        route("/api") {
            route("/orders") {
                get {
                    call.respondText("all")
                }
                post("/{id}") {
                    call.respondText("one")
                }
            }
        }
        orderRoutes()
    }
}

fun Route.orderRoutes() {
    delete("/orders/{id}") {
        call.respondText("gone")
    }
}

fun lookup(values: Map<String, String>): String? {
    return values.get("key")
}
