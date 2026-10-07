module Shop
  module CLI
    class Accounts < Base
      desc 'create NAME', 'Create an account'
      def create(name)
        Account.create!(name: name)
      end

      private

      def announce(text)
        say(text)
      end
    end
  end
end
