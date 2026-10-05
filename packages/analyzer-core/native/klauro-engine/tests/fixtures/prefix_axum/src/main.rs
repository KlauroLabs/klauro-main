mod users;

use axum::{routing::get, Router};

fn app() -> Router {
    Router::new()
        .route("/health", get(health))
        .nest("/api/users", users::routes())
}

async fn health() -> &'static str {
    "ok"
}

fn main() {
    let _ = app();
}
