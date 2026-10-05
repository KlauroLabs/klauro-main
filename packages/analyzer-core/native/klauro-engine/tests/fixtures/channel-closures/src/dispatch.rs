pub fn dispatch(channel: &str, args: Vec<i32>) -> Option<i32> {
    match channel {
        "archive:set-root" => args.iter().map(|held| held + 1).find(|held| *held > 2),
        "archive:chats" => args.first().and_then(|held| Some(held * 2)),
        _ => None,
    }
}

pub fn dispatch_if(channel: &str, args: Vec<i32>) -> Option<i32> {
    if channel == "archive:count" {
        return args.iter().map(|held| held + 1).max();
    }
    None
}
