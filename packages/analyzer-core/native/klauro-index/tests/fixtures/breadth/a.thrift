include "shared.thrift"

struct Session {
  1: string token
}

service Directory {
  Session lookup(1: string name)
}
