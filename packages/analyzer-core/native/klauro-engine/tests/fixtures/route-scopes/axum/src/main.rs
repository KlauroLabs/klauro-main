use axum::{middleware, routing::{get, post}, Router};

async fn list_users() -> &'static str { "all" }
async fn create_user() -> &'static str { "created" }
async fn require_auth() {}

fn open() -> Router {
    Router::new().route("/users", get(list_users))
}

fn closed() -> Router {
    Router::new()
        .route("/users", post(create_user))
        .layer(middleware::from_fn(require_auth))
}
