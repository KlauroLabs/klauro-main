#include <stdio.h>

struct Session {
    char *identifier;
    long started;
};

int persist(const char *id) {
    return printf("%s", id);
}

int session_close(struct Session *s, int force) {
    if (force) {
        return 0;
    }
    return persist(s->identifier);
}
