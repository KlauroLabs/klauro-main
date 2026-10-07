use serde_json::Value;

pub fn account_of(payload: &Value) -> Option<&Value> {
    payload.get("https://api.stripe.com/account")
}
