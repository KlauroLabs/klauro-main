mod common;

fn injections(fixture: &str) -> Vec<String> {
    let index = common::read(fixture);
    let name = |id: &str| id.rsplit(':').next().unwrap_or(id).to_string();
    let mut held: Vec<String> = index["injections"]
        .as_array()
        .map(|all| {
            all.iter()
                .map(|held| format!("{} injects {}", name(held["source"].as_str().unwrap()), name(held["target"].as_str().unwrap())))
                .collect()
        })
        .unwrap_or_default();
    held.sort();
    held
}

#[test]
fn a_spring_constructor_injects_the_services_it_receives() {
    assert_eq!(injections("injection/spring"), vec!["UserController injects UserService", "UserService injects UserRepository"]);
}

#[test]
fn a_nest_constructor_injects_the_providers_it_receives() {
    assert_eq!(injections("injection/nest"), vec!["UserController injects UserService", "UserService injects UserRepository"]);
}

#[test]
fn an_interface_is_injected_as_the_class_that_implements_it() {
    assert_eq!(injections("injection/aspnet"), vec!["UsersController injects UserService"]);
}

#[test]
fn a_depends_default_injects_the_provider_and_a_never_resolved_constructor_default_does_not() {
    assert_eq!(
        injections("injection/fastapi"),
        vec!["get_service injects get_repo", "list_users injects get_service", "remove_user injects get_service"]
    );
}
