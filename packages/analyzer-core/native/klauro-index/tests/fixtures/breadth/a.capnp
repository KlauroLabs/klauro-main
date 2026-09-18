@0xdbb9ad1f14bf0b36;

struct Session {
  token @0 :Text;
}

interface Directory {
  lookup @0 (name :Text) -> (session :Session);
}
