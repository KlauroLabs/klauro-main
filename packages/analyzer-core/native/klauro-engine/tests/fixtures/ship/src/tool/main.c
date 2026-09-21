#include <stdio.h>

int helper(int value) {
  return value * 2;
}

int main(void) {
  printf("%d\n", helper(21));
  return 0;
}
