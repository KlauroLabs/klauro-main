trait Driver {
    fn spawn(&mut self) -> bool;
}

struct Local;

impl Driver for Local {
    fn spawn(&mut self) -> bool {
        std::process::Command::new("tool").spawn().is_ok()
    }
}

struct Runtime<D: Driver> {
    driver: D,
}

impl<D: Driver> Runtime<D> {
    fn start(&mut self) -> bool {
        self.driver.spawn()
    }
}

struct Hub;

fn begin(runtime: &mut Runtime<Local>) -> bool {
    runtime.start()
}

fn run_with_argument(driver: &mut impl Driver) -> bool {
    driver.spawn()
}

fn run_with_bound<T>(driver: &mut T) -> bool
where
    T: Driver,
{
    driver.spawn()
}

fn main() {
    let hub = Hub;
    let _ = hub;
}
