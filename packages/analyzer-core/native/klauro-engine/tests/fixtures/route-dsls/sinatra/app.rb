require 'sinatra'

get '/users' do
  'users'
end

namespace '/api' do
  get '/health' do
    'ok'
  end
end
