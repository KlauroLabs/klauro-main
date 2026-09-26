plugins {
  id("app.shelf.compose")
}

dependencies {
  implementation(projects.tasks)
}

compose.desktop {
  application {
    mainClass = "app.MainKt"
  }
}
