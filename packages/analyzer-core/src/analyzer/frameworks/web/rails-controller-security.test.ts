import assert from 'node:assert/strict';
import test from 'node:test';
import { extractRailsSecurityMixin, railsCallbackApplies, railsIncludedModules, resolveRailsControllerSecurity } from './rails-controller-security';

const symbols = (options: string, key: string): string[] => {
  const expression = key === "only" ? /only:\s*(?:%i\[([^\]]*)\]|\[([^\]]*)\]|:(\w+))/ : /except:\s*(?:%i\[([^\]]*)\]|\[([^\]]*)\]|:(\w+))/;
  const match = options.match(expression);
  if (!match) return [];
  if (match[1] !== undefined) return match[1].split(/\s+/).filter(Boolean);
  if (match[2] !== undefined) return (match[2].match(/:(\w+)/g) || []).map(value => value.slice(1));
  return [match[3]];
};

test('resolves multiline included concern authentication through controller inheritance', () => {
  const concern = extractRailsSecurityMixin(`
module Authentication
  extend ActiveSupport::Concern
  included do
    before_action :authenticate_user!, except: [:index]
  end
  class_methods do
    def skip_authentication(**options)
      skip_before_action :authenticate_user!, **options
    end
  end
end
`, 'app/controllers/concerns/authentication.rb', symbols)!;
  assert.deepEqual(railsIncludedModules('include Layout, Onboardable,\n  Authentication, Invitable'), ['Layout', 'Onboardable', 'Authentication', 'Invitable']);
  const application = { name: 'ApplicationController', filePath: 'app/controllers/application_controller.rb', beforeActions: [], skipBeforeActions: [], includedConcerns: ['Authentication'], callbackInvocations: [] };
  const chats = { name: 'ChatsController', filePath: 'app/controllers/chats_controller.rb', parentName: 'ApplicationController', beforeActions: [], skipBeforeActions: [], includedConcerns: [], callbackInvocations: [] };
  resolveRailsControllerSecurity([application, chats], [concern]);
  assert.equal(chats.beforeActions[0].name, 'authenticate_user!');
  assert.equal(chats.beforeActions[0].inherited, true);
  assert.equal(railsCallbackApplies(chats.beforeActions[0], 'create'), true);
  assert.equal(railsCallbackApplies(chats.beforeActions[0], 'index'), false);
});

test('expands a concern-defined skip macro with its invocation scope', () => {
  const concern = extractRailsSecurityMixin(`
module Authentication
  included do
    before_action :authenticate_user!
  end
  class_methods do
    def skip_authentication(**options)
      skip_before_action :authenticate_user!, **options
    end
  end
end
`, 'app/controllers/concerns/authentication.rb', symbols)!;
  const controller = { name: 'PublicController', filePath: 'app/controllers/public_controller.rb', beforeActions: [], skipBeforeActions: [], includedConcerns: ['Authentication'], callbackInvocations: [{ name: 'skip_authentication', only: ['index'], except: [], line: 3 }] };
  resolveRailsControllerSecurity([controller], [concern]);
  assert.equal(controller.skipBeforeActions[0].name, 'authenticate_user!');
  assert.equal(railsCallbackApplies(controller.skipBeforeActions[0], 'index'), true);
  assert.equal(railsCallbackApplies(controller.skipBeforeActions[0], 'create'), false);
});
