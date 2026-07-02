#include <cstdio>
#include "shared.h"

int main() {
  std::printf("server starting, 1+1=%d\n", shared_add(1, 1));
  return 0;
}
