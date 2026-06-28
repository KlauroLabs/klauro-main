#include "math.h"
static int neg(int x) { return -x; }
int add(int a, int b) { return a + b; }
int sub(int a, int b) { return add(a, neg(b)); }
