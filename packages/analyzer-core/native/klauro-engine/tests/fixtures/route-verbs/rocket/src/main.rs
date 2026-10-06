#[macro_use] extern crate rocket;

#[get("/users")]
fn list_users() -> &'static str { "all users" }

#[post("/users")]
fn create_user() -> &'static str { "created" }

#[get("/ping")]
fn ping() -> &'static str { "pong" }

#[launch]
fn rocket() -> _ {
    rocket::build()
        .mount("/api", routes![list_users, create_user])
        .mount("/", routes![ping])
}
