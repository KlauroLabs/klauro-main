Rails.application.routes.draw do
  get 'health', to: 'health#show'

  namespace :admin do
    resources :users, only: [:index, :show]
    get 'stats', to: 'stats#show'
  end

  scope '/v1' do
    get 'ping', to: 'health#ping'
  end

  draw(:api)
end
