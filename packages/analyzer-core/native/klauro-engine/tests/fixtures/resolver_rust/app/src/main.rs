use render_core::{make_printer, Builder, Printer, Sink};

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

fn each_printer(printers: Vec<Printer>) -> usize {
    let mut total = 0;
    for printer in printers {
        total += printer.sink().flush() as usize;
    }
    total
}

fn mapped(printers: &[Printer]) -> Vec<usize> {
    printers.iter().map(|printer| printer.width()).collect()
}

fn main() {
    chained();
    from_a_function();
    through_a_static_path();
}
