use axum::{routing::{get, post}, Router};

pub fn routes() -> Router {
    Router::new()
        .route("/", get(list_users))
        .route("/:id", get(show_user).post(update_user))
}

async fn list_users() -> &'static str {
    "[]"
}

async fn show_user() -> &'static str {
    "{}"
}

async fn update_user() -> &'static str {
    "{}"
}
