fn boot(chat: &str) -> std::io::Result<()> {
    let archive = core_lib::archive::global()?;
    archive.delete_session(chat)
}

fn main() {}
