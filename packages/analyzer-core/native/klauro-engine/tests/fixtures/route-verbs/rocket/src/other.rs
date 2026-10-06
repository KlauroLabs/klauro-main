#[get("/users")]
pub fn list_users() -> &'static str { "other users" }

#[get("/never")]
pub fn unmounted() -> &'static str { "never mounted" }
