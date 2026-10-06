fn about(client: &Client, base: &str) {
    client.get(format!("/{}/about", base)).dispatch();
}
