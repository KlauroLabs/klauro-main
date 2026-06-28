#include "math.h"
class Calc {
public:
    int run(int a, int b) { return add(a, b) + helper(); }
private:
    int helper() { return 42; }
};
int main() { Calc c; return c.run(1, 2); }
