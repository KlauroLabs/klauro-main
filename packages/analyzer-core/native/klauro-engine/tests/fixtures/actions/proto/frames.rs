pub enum Message {
    Ping,
    Text(String),
}

pub fn answer(message: Message) -> usize {
    match message {
        Message::Ping => pong(),
        Message::Text(said) => said.len(),
    }
}

fn pong() -> usize {
    0
}
