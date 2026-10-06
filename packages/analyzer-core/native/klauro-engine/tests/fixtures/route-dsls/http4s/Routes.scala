import cats.effect.IO
import org.http4s._
import org.http4s.dsl.io._

object Routes {
  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case GET -> Root / "users" =>
      Ok("list")
    case DELETE -> Root / "users" / IntVar(id) =>
      Ok(s"deleted $id")
  }
}
