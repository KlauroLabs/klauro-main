/// Async library for testing async patterns
/// 
/// This module demonstrates various async programming patterns
/// using Tokio runtime.
use tokio::task;
use futures::future::join_all;
use std::time::Duration;

/// Service for async operations
pub struct AsyncService {
    counter: std::sync::atomic::AtomicU32,
}

impl AsyncService {
    /// Create new async service
    pub fn new() -> Self {
        AsyncService {
            counter: std::sync::atomic::AtomicU32::new(0),
        }
    }
    
    /// Increment counter asynchronously
    /// 
    /// # Returns
    /// 
    /// * `u32` - New counter value
    pub async fn increment(&self) -> u32 {
        // Simulate async operation
        tokio::time::sleep(Duration::from_millis(10)).await;
        self.counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    }
    
    /// Process multiple items concurrently
    /// 
    /// # Arguments
    /// 
    /// * `items` - Items to process
    /// 
    /// # Returns
    /// 
    /// * `Vec<u32>` - Processed items
    pub async fn process_concurrent(&self, items: Vec<u32>) -> Vec<u32> {
        let futures: Vec<_> = items
            .into_iter()
            .map(|item| {
                let service = self;
                async move {
                    service.increment().await;
                    item * 2
                }
            })
            .collect();
            
        join_all(futures).await
    }
}

/// Async trait for testing
pub trait AsyncProcessor {
    /// Process data asynchronously
    /// 
    /// # Errors
    /// 
    /// * May return error if processing fails
    async fn process(&self, data: &str) -> Result<String, String>;
}

pub struct StringProcessor;

impl AsyncProcessor for StringProcessor {
    async fn process(&self, data: &str) -> Result<String, String> {
        if data.is_empty() {
            return Err("Data cannot be empty".to_string());
        }
        
        // Simulate async processing
        tokio::time::sleep(Duration::from_millis(5)).await;
        
        Ok(data.to_uppercase())
    }
}

/// Example async function
/// 
/// # Examples
/// 
/// ```
/// use async_tokio::*;
/// tokio::spawn(async {
///     let result = process_string("hello").await;
///     println!("{}", result.unwrap());
/// });
/// ```
pub async fn process_string(data: &str) -> Result<String, String> {
    let processor = StringProcessor;
    processor.process(data).await
}

/// Function that may panic for testing
pub fn dangerous_operation(input: &str) -> String {
    if input == "panic" {
        todo!("This should be implemented properly");
    }
    
    unimplemented!("This feature is not yet implemented")
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[tokio::test]
    async fn test_async_increment() {
        let service = AsyncService::new();
        let result = service.increment().await;
        assert_eq!(result, 1);
    }
    
    #[tokio::test] 
    async fn test_concurrent_processing() {
        let service = AsyncService::new();
        let items = vec![1, 2, 3];
        let results = service.process_concurrent(items).await;
        assert_eq!(results, vec![2, 4, 6]);
    }
}