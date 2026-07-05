package com.example

import akka.http.scaladsl.server.Directives._

trait UserRoutes {

  val routes =
    path("users") {
      get {
        complete("list users")
      } ~
      post {
        complete("create user")
      }
    } ~
    path("users" / IntNumber) { id =>
      get {
        complete(s"user ${id}")
      }
    }
}
