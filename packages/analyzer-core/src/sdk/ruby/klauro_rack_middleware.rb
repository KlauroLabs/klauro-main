require "json"
require "net/http"
require "time"
require "uri"

class KlauroRackMiddleware
  def initialize(app, service_name: nil, environment: nil, file_path: nil, endpoint: nil,
                 batch_size: 20, flush_interval: 5)
    @app = app
    @service_name = service_name
    @environment = environment
    @file_path = file_path
    @endpoint = endpoint && URI(endpoint)
    @batch_size = batch_size
    @buffer = []
    @mutex = Mutex.new
    @flusher = Thread.new do
      loop do
        sleep flush_interval
        flush
      end
    end
  end

  def call(env)
    started_at = Time.now
    status, headers, body = @app.call(env)
    record(env, status, started_at, nil)
    [status, headers, body]
  rescue StandardError => error
    record(env, 500, started_at, error)
    raise
  end

  def flush
    events = @mutex.synchronize { @buffer.slice!(0, @buffer.length) }
    deliver(events) unless events.empty?
  end

  def shutdown
    @flusher.kill
    flush
  end

  private

  def record(env, status, started_at, error)
    event = {
      kind: error || status >= 500 ? "error" : "request",
      timestamp: started_at.utc.iso8601(3),
      service_name: @service_name,
      environment: @environment,
      method: env["REQUEST_METHOD"],
      route: route_pattern(env),
      path: env["PATH_INFO"],
      status: status,
      duration_ms: ((Time.now - started_at) * 1000).round,
    }.compact
    if error
      event[:error] = {
        type: error.class.name,
        message: error.message,
        stack_top_frames: (error.backtrace || []).first(5).map { |frame| stack_frame(frame) },
      }
    end
    params = env["action_dispatch.request.path_parameters"]
    if params && params[:controller]
      event[:file_hint] = "app/controllers/#{params[:controller]}_controller.rb"
      event[:function_hint] = params[:action]
    end
    full = @mutex.synchronize do
      @buffer << event
      @buffer.length >= @batch_size
    end
    flush if full
  end

  def route_pattern(env)
    pattern = env["action_dispatch.route_uri_pattern"] || env["sinatra.route"]&.split(" ", 2)&.last
    pattern&.sub(/\(\.:format\)\z/, "")
  end

  def stack_frame(frame)
    match = frame.match(/\A(.+?):(\d+)(?::in [`'](.+?)'?)?\z/)
    return { file: frame } unless match
    { file: match[1], line: match[2].to_i, function: match[3] }.compact
  end

  def deliver(events)
    if @file_path
      File.open(@file_path, "a") { |file| events.each { |event| file.puts(event.to_json) } }
    end
    return unless @endpoint
    request = Net::HTTP::Post.new(@endpoint, "Content-Type" => "application/json")
    request.body = JSON.generate(events: events)
    Net::HTTP.start(@endpoint.host, @endpoint.port, use_ssl: @endpoint.scheme == "https") do |client|
      client.request(request)
    end
  rescue StandardError
    nil
  end
end
