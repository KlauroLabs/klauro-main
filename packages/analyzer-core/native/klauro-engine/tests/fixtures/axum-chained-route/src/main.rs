use axum::{extract::Path, routing::post, Router};

async fn handle(Path(chat_id): Path<String>) -> String {
    chat_id
}

fn serve() -> Router {
    Router::new().route("/mcp/{chat_id}", post(handle))
}

fn main() {
    serve();
}
