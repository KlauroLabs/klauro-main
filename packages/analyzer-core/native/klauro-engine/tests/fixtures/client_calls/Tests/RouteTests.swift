import Vapor

func configure(_ app: Application) throws {
    app.get("hello") { request in "hi" }
}
