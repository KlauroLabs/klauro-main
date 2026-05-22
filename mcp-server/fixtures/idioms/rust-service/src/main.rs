use rust_service_idiom_fixture::users::create_user;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    create_user("tenant-1", "ada@example.com").await?;
    Ok(())
}
