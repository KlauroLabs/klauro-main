ThisBuild / scalaVersion := "2.13.12"

lazy val root = (project in file("."))
  .settings(
    name := "http4s-routes-fixture",
    libraryDependencies ++= Seq(
      "org.http4s" %% "http4s-ember-server" % "0.23.23",
      "org.http4s" %% "http4s-dsl"          % "0.23.23",
      "org.http4s" %% "http4s-circe"        % "0.23.23"
    )
  )
