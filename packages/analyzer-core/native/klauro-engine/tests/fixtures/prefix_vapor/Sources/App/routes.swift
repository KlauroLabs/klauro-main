import Vapor

func routes(_ app: Application) throws {
    app.get("health") { req in "ok" }

    let api = app.grouped("api", "v1")
    api.get("ping") { req in "pong" }
    try api.register(collection: TodoController())
    todoRoutes(api)
}

func todoRoutes(_ routes: RoutesBuilder) {
    let todos = routes.grouped("todos")
    todos.get { req in "[]" }
    todos.post { req in "{}" }
}
