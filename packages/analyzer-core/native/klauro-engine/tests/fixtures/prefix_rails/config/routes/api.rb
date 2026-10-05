namespace :api do
  resources :orders, only: [:index]
end
