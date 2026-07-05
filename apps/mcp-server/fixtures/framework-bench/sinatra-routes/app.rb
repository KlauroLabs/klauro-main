require 'sinatra'
require 'sinatra/base'

before do
  protected!
end

get '/' do
  'home'
end

get '/users/:id' do |id|
  "user #{id}"
end

post '/users' do
  status 201
end

put '/users/:id' do |id|
  'updated'
end

delete '/users/:id' do |id|
  status 204
end

namespace '/api' do
  get '/health' do
    'ok'
  end

  post '/items' do
    status 201
  end
end
