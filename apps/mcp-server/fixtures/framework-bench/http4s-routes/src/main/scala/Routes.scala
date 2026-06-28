package com.example.api

import cats.effect.IO
import org.http4s._
import org.http4s.dsl.io._
import org.http4s.server.AuthMiddleware

final case class User(id: Long, name: String)

object Routes {

  // Public routes — no auth.
  val publicRoutes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case GET -> Root / "users" =>
      Ok("list users")

    case GET -> Root / "users" / IntVar(id) =>
      Ok(s"user $id")

    case POST -> Root / "login" =>
      Ok("login")

    case GET -> Root / "health" =>
      Ok("ok")
  }

  // Protected routes — wrapped by AuthMiddleware via AuthedRoutes.
  val authedRoutes: AuthedRoutes[User, IO] = AuthedRoutes.of[User, IO] {
    case GET -> Root / "me" as user =>
      Ok(user.name)

    case DELETE -> Root / "users" / IntVar(id) as user =>
      Ok(s"deleted $id by ${user.name}")
  }

  val authMiddleware: AuthMiddleware[IO, User] = ???

  val all: HttpRoutes[IO] = publicRoutes <+> authMiddleware(authedRoutes)
}
