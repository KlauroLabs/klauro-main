Rails.application.routes.draw do
  root 'home#index'
  namespace :api do
    namespace :v1 do
      resources :statuses, only: [:show, :destroy] do
        scope module: :statuses do
          resource :favourite, only: :create
          post :unfavourite, to: 'favourites#destroy'
        end
      end
    end
  end
end
