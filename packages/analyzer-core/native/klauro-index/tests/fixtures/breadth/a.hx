package app;

class Greeter {
  public function greet(name:String):String {
    return name;
  }

  public function run():String {
    return greet("world");
  }
}
