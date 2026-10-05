pub struct Sink {
    open: bool,
}

impl Sink {
    pub fn open(width: usize) -> Self {
        Sink { open: width > 0 }
    }

    pub fn flush(&mut self) -> bool {
        self.open
    }
}
