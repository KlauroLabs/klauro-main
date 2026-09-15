package fixture;

import java.util.List;

public class Session extends Base {
    private String identifier;
    private long started;

    public Session(String identifier) {
        this.identifier = identifier;
    }

    public boolean close(boolean force) {
        if (force) {
            throw new IllegalStateException("forced");
        }
        return persist(identifier);
    }

    private boolean persist(String id) {
        return List.of(id).isEmpty();
    }
}
