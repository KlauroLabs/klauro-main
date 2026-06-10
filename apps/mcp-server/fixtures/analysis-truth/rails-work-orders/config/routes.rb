Rails.application.routes.draw do
  resources :work_orders, only: [:index, :show, :create, :update, :destroy]
end
