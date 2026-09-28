pub mod ch {
    pub const START: &str = "klauro-analysis:start";
    pub const STATE: &str = "klauro-analysis:state";
}

pub fn dispatch(channel: &str, payload: &str) -> String {
    match channel {
        ch::START => start_analysis(payload),
        ch::STATE => analysis_state(payload),
        _ => String::new(),
    }
}

fn start_analysis(payload: &str) -> String {
    payload.to_string()
}

fn analysis_state(payload: &str) -> String {
    payload.to_string()
}
