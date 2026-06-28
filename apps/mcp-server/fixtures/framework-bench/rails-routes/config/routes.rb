Rails.application.routes.draw do
  get '/users', to: 'users#index'
  post '/users', to: 'users#create'
  delete '/users/:id', to: 'users#destroy'
end
