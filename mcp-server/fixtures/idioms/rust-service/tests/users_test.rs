use rust_service_idiom_fixture::users::normalize_email;

#[test]
fn normalizes_email() {
    assert_eq!(normalize_email(" ADA@example.com "), "ada@example.com");
}
