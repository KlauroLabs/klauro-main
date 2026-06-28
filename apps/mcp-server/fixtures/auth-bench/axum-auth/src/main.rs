use axum::{
    Router,
    routing::{get, post, delete},
    middleware,
    http::Request,
    body::Body,
    response::Response,
    middleware::Next,
};

async fn list_users() -> &'static str { "all users" }
async fn create_user() -> &'static str { "created" }
async fn delete_user() -> &'static str { "deleted" }

async fn require_auth(req: Request<Body>, next: Next) -> Response {
    // pretend to validate a bearer token here
    next.run(req).await
}

// Public routes: no auth layer — GET /users is open.
fn public_routes() -> Router {
    Router::new()
        .route("/users", get(list_users))
}

// Protected routes: the auth middleware is applied INSIDE this local function's own
// Router chain (single file, layer in the chain body), so POST/DELETE are protected.
fn protected_routes() -> Router {
    Router::new()
        .route("/users", post(create_user))
        .route("/users/:id", delete(delete_user))
        .layer(middleware::from_fn(require_auth))
}

fn app() -> Router {
    Router::new()
        .merge(public_routes())
        .merge(protected_routes())
}

#[tokio::main]
async fn main() {
    let _ = app();
}
