mod keys;

#[routes::routes(
    routes(
        "/health" => get(get_health),
        "/keys" => sub(keys::KeysApi),
    ),
    tag = "Root",
)]
pub struct ServerApi;

async fn get_health() -> &'static str {
    "ok"
}

fn main() {}
