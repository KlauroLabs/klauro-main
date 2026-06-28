use actix_web::{get, post, delete, web, HttpResponse};

#[get("/users")]
async fn list_users() -> HttpResponse {
    HttpResponse::Ok().finish()
}

#[post("/users")]
async fn create_user() -> HttpResponse {
    HttpResponse::Created().finish()
}

#[delete("/users/{id}")]
async fn delete_user(_path: web::Path<u32>) -> HttpResponse {
    HttpResponse::NoContent().finish()
}
