import Vapor

public func configure(_ app: Application) throws {
    app.middleware.use(ErrorMiddleware.default(environment: app.environment))
    try routes(app)
}

struct User: Content, Authenticatable {
    var id: Int?
    var name: String = ""
}

struct UserAuthenticator: AsyncBearerAuthenticator {
    func authenticate(bearer: BearerAuthorization, for request: Request) async throws {
        // verify token, set request.auth
    }
}
