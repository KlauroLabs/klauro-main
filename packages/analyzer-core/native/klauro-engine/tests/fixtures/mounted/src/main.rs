use actix_web::{web, App, HttpResponse, HttpServer};

async fn list_tasks() -> HttpResponse {
    HttpResponse::Ok().finish()
}

async fn create_dump() -> HttpResponse {
    HttpResponse::Ok().finish()
}

async fn health() -> HttpResponse {
    HttpResponse::Ok().finish()
}

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource("/tasks").route(web::get().to(list_tasks)))
        .service(web::resource("/dumps").route(web::post().to(create_dump)))
        .route("/health", web::get().to(health));
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| App::new().configure(configure)).bind(("127.0.0.1", 8080))?.run().await
}
