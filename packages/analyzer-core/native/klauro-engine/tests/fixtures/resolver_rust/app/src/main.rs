use render_core::{make_printer, Builder, Sink};

fn chained() -> usize {
    let printer = Builder::new().width(4).build();
    printer.width()
}

fn from_a_function() -> bool {
    let printer = make_printer();
    let mut sink = printer.sink();
    sink.flush()
}

fn through_a_static_path() -> bool {
    let mut sink = Sink::open(2);
    sink.flush()
}

fn main() {
    chained();
    from_a_function();
    through_a_static_path();
}
