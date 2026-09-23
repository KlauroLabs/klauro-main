import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

public class Shown {
    public List<String> load(Path path) throws Exception {
        return Files.readAllLines(path);
    }
}
