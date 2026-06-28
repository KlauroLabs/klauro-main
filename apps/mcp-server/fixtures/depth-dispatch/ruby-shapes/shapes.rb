# Ruby is OUTSIDE codebase-memory's Hybrid-LSP set (py/ts/js/php/c#/go/c/c++/java/kotlin/rust),
# so this is an out-of-category case for cbm.

# Duck-typed "interface": Notifier defines #deliver; two concrete impls + a decoy.
module Notifier
  def deliver(msg); raise NotImplementedError; end
end

class EmailNotifier
  include Notifier
  def deliver(msg); "email: #{msg}"; end
end

class SmsNotifier
  include Notifier
  def deliver(msg); "sms: #{msg}"; end
end

# Decoy: same-named #deliver but does NOT include Notifier.
class PizzaShop
  def deliver(msg); "pizza to #{msg}"; end
end

class Dispatcher
  # The dispatch call site: @channel holds a Notifier; @channel.deliver dispatches
  # to a concrete Notifier impl (EmailNotifier, SmsNotifier), never PizzaShop.
  def initialize(channel)
    @channel = channel
  end

  def send_all(msg)
    @channel.deliver(msg)
  end
end
