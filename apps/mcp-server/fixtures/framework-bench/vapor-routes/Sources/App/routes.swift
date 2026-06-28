import Vapor

func routes(_ app: Application) throws {
    // Top-level routes registered directly on the application.
    app.get("health", use: health)
    app.post("login", use: login)

    // Path-prefix group: every route below is under /users.
    let users = app.grouped("users")
    users.get(use: listUsers)
    users.get(":id", use: getUser)

    // Authenticated group: middleware applies auth to every nested route.
    let protected = app.grouped(UserAuthenticator()).grouped(User.guardMiddleware())
    protected.get("me", use: me)
    protected.delete("users", ":id", use: deleteUser)
}

func health(req: Request) async throws -> String { "ok" }
func login(req: Request) async throws -> Response { Response(status: .ok) }
func listUsers(req: Request) async throws -> [User] { [] }
func getUser(req: Request) async throws -> User { User() }
func me(req: Request) async throws -> User { try req.auth.require(User.self) }
func deleteUser(req: Request) async throws -> HTTPStatus { .noContent }
