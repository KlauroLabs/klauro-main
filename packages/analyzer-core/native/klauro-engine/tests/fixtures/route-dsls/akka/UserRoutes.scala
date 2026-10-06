import akka.http.scaladsl.server.Directives._

trait UserRoutes {
  val routes =
    pathPrefix("api") {
      path("users") {
        get {
          complete("list")
        } ~
        post {
          complete("create")
        }
      } ~
      path("users" / IntNumber) { id =>
        get {
          complete("one")
        }
      }
    }
}
