import Vapor

struct TodoController: RouteCollection {
    func boot(routes: RoutesBuilder) throws {
        let items = routes.grouped("items")
        items.get(use: index)
        items.get(":id", use: show)
    }

    func index(req: Request) -> String { "[]" }
    func show(req: Request) -> String { "{}" }
}
