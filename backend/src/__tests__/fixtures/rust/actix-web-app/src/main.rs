use actix_web::{get, post, web, App, HttpServer, HttpResponse, Responder};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct User {
    pub id: u32,
    pub name: String,
    pub email: String,
}

/// User service for business logic
pub struct UserService;

impl UserService {
    /// Create a new user
    /// 
    /// # Arguments
    /// 
    /// * `user` - User data to create
    /// 
    /// # Returns
    /// 
    /// * `Result<User, String>` - Created user or error
    /// 
    /// # Errors
    /// 
    /// * Returns error if email already exists
    pub fn create_user(user: User) -> Result<User, String> {
        // TODO: Validate email uniqueness
        if user.email.is_empty() {
            return Err("Email cannot be empty".to_string());
        }
        
        // TODO: Hash password before storing
        Ok(user)
    }
    
    /// Get user by ID
    /// 
    /// # Arguments
    /// 
    /// * `id` - User ID to search for
    pub fn get_user_by_id(id: u32) -> Option<User> {
        Some(User { id, name: "Test User".to_string(), email: "test@example.com".to_string() })
    }
}

#[get("/users/{id}")]
pub async fn get_user(
    path: web::Path<u32>,
    user_service: web::Data<UserService>
) -> impl Responder {
    match user_service.get_user_by_id(*path) {
        Some(user) => HttpResponse::Ok().json(User),
        None => HttpResponse::NotFound().json("User not found")
    }
}

#[post("/users")]
pub async fn create_user(
    user: web::Json<User>,
    user_service: web::Data<UserService>
) -> impl Responder {
    match user_service.create_user(user.into_inner()) {
        Ok(created_user) => HttpResponse::Created().json(created_user),
        Err(error) => HttpResponse::BadRequest().json(error)
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let user_service = UserService;
    
    HttpServer::new(
        App::new()
            .app_data(web::Data::new(user_service))
            .service(get_user)
            .service(create_user)
    )
    .bind("127.0.0.1:8080")?
    .run()
    .await
}