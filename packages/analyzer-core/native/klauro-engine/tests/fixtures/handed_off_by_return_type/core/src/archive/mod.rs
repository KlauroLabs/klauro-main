mod layout;

pub struct Archive {
    pub root: String,
}

pub struct Store;

impl Store {
    pub fn get(&self) -> i32 {
        0
    }
}

pub struct Other;

impl Other {
    pub fn get(&self) -> i32 {
        99
    }
}

pub struct Cache {
    pub store: Store,
}

impl Cache {
    pub fn read(&self) -> i32 {
        self.store.get()
    }
}

pub fn global() -> std::io::Result<&'static Archive> {
    unimplemented!()
}

pub fn shared() -> std::sync::Arc<Store> {
    unimplemented!()
}

pub fn maybe() -> Option<Box<Store>> {
    None
}

impl Archive {
    pub fn open(root: String) -> std::io::Result<Archive> {
        Ok(Archive { root })
    }

    pub fn delete_session(&self, chat: &str) -> std::io::Result<()> {
        layout::delete_session(&self.root, chat)
    }
}

pub fn dispatch(channel: &str, chat: &str) -> std::io::Result<()> {
    let a = global()?;
    let cached = shared();
    let found = maybe().unwrap();
    let hit = cached.get() + found.get();
    let _ = hit;
    match channel {
        "archive:delete" => {
            a.delete_session(chat)?;
            Ok(())
        }
        _ => Ok(()),
    }
}
