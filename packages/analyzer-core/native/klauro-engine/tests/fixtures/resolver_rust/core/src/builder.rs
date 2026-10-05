use crate::sink::Sink;

pub struct Builder {
    width: usize,
}

impl Builder {
    pub fn new() -> Builder {
        Builder { width: 0 }
    }

    pub fn width(&mut self, width: usize) -> &mut Builder {
        self.width = width;
        self
    }

    pub fn build(&self) -> Printer {
        Printer { width: self.width }
    }
}

pub struct Printer {
    width: usize,
}

impl Printer {
    pub fn width(&self) -> usize {
        self.width
    }

    pub fn sink(&self) -> Sink {
        Sink::open(self.width)
    }
}

pub fn make_printer() -> Printer {
    Builder::new().build()
}
