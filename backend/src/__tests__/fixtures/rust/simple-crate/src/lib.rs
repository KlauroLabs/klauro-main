/// Simple library for testing Rust analyzer
///
/// This module provides basic struct and function examples
/// for comprehensive analyzer testing.
///
/// # Examples
///
/// ```
/// use simple_crate::*;
///
/// let user = User::new("Alice", 25);
/// let greeting = greet(&user);
/// ```
pub struct User {
    /// User's name
    pub name: String,

    /// User's age in years
    pub age: u32,
}

impl User {
    /// Create a new User instance
    ///
    /// # Arguments
    ///
    /// * `name` - The user's name
    /// * `age` - The user's age
    ///
    /// # Returns
    ///
    /// * `User` - New user instance
    pub fn new(name: String, age: u32) -> Self {
        User { name, age }
    }

    /// Get user's name as a greeting
    ///
    /// # Returns
    ///
    /// * `String` - Greeting message
    pub fn greet(&self) -> String {
        format!("Hello, {}! You are {} years old.", self.name, self.age)
    }
}

/// Simple function for testing
///
/// # Panics
///
/// Panics if name is empty
pub fn greet(name: &str) -> String {
    if name.is_empty() {
        panic!("Name cannot be empty!");
    }
    format!("Hello, {}!", name)
}

/// Trait for testing trait analysis
pub trait Greeter {
    /// Generate greeting message
    fn greet(&self) -> String;
}

impl Greeter for User {
    fn greet(&self) -> String {
        self.greet()
    }
}

/// Enum for testing enum analysis
pub enum Status {
    /// Active status
    Active,

    /// Inactive status
    Inactive,

    /// Pending status with custom data
    Pending(String),
}

/// Result type for testing
pub type Result<T> = std::result::Result<T, String>;
