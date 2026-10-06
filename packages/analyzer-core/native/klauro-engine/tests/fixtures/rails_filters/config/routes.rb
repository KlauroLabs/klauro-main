Rails.application.routes.draw do
  namespace :admin do
    get '/dashboard', to: 'dashboard#index'
  end

  get 'old', to: redirect('/new'), as: nil

  with_options to: 'pages#show' do
    get '/about'
  end

  resources :posts, only: [:index, :show]
  get 'secret', to: 'posts#secret'
end
