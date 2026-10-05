require 'sinatra'

get '/users' do
  'users'
end

post '/users' do
  'created'
end

delete '/users/:id' do
  'gone'
end
