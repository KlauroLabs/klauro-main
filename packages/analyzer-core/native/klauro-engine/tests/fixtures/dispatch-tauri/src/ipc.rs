pub fn dispatch(channel: &str, payload: &str) -> String {
    if channel == "archive:resolve" {
        return resolve_archive(payload);
    }
    crate::klauro_analysis::dispatch(channel, payload)
}

fn resolve_archive(payload: &str) -> String {
    payload.to_string()
}
