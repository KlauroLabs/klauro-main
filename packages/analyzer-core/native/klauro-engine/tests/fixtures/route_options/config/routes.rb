Rails.application.routes.draw do
  scope path: '.well-known' do
    get 'oauth-authorization-server', to: 'metadata#show', as: :oauth_metadata
    get 'proxy', to: redirect { |_, request| "/authorize_interaction?#{request.params.to_query}" }, as: nil
  end
end
