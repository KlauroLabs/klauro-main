#include <cstdio>
#include "shared.h"

int main() {
  std::printf("tool running, 2+3=%d\n", shared_add(2, 3));
  return 0;
}
