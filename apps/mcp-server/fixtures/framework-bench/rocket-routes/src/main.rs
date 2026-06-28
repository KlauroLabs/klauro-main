#[macro_use] extern crate rocket;

#[get("/users")]
fn list_users() -> &'static str { "all users" }

#[post("/users")]
fn create_user() -> &'static str { "created" }

#[delete("/users/<id>")]
fn delete_user(id: u32) -> String { format!("deleted {}", id) }

#[launch]
fn rocket() -> _ {
    rocket::build().mount("/", routes![list_users, create_user, delete_user])
}
