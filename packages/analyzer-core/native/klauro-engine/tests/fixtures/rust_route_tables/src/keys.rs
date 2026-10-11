#[routes::routes(
    routes(
        "" => [post(create_key), get(list_keys)],
        "/{key}" => [get(get_key), delete(delete_key)],
    ),
    tag = "Keys",
)]
pub struct KeysApi;

pub async fn create_key() -> String { String::new() }
pub async fn list_keys() -> Vec<String> { Vec::new() }
pub async fn get_key() -> String { String::new() }
pub async fn delete_key() -> bool { true }
