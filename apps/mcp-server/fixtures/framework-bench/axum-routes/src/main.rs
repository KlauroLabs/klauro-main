use axum::{Router, routing::{get, post, delete}};

async fn list_users() -> &'static str { "all users" }
async fn create_user() -> &'static str { "created" }
async fn delete_user() -> &'static str { "deleted" }

fn app() -> Router {
    Router::new()
        .route("/users", get(list_users))
        .route("/users", post(create_user))
        .route("/users/:id", delete(delete_user))
}

#[tokio::main]
async fn main() {
    let _ = app();
}
