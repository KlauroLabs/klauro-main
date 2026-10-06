use actix_web::{get, web, App, HttpServer, HttpResponse};

#[get("/ping")]
async fn ping() -> HttpResponse { HttpResponse::Ok().finish() }

async fn list() -> HttpResponse { HttpResponse::Ok().finish() }
async fn create() -> HttpResponse { HttpResponse::Ok().finish() }
async fn both() -> HttpResponse { HttpResponse::Ok().finish() }
async fn show() -> HttpResponse { HttpResponse::Ok().finish() }

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new()
            .service(ping)
            .route("/users", web::get().to(list))
            .service(
                web::scope("/api")
                    .route("/items", web::post().to(create))
                    .service(web::resource("/items/{id}").route(web::get().to(show)))
                    .service(
                        web::resource(["/alpha", "/beta"])
                            .name("multi")
                            .route(web::get().to(both))
                            .route(web::post().to(both)),
                    ),
            )
    })
    .bind(("127.0.0.1", 8080))?
    .run()
    .await
}
