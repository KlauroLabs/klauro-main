use std::io;

pub struct Session {
    pub identifier: String,
    pub started: u64,
}

impl Session {
    pub fn close(&self, force: bool) -> Result<(), io::Error> {
        if force {
            return Ok(());
        }
        persist(&self.identifier)
    }
}

fn persist(identifier: &str) -> Result<(), io::Error> {
    Ok(())
}
