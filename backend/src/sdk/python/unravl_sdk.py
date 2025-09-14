import time
import json
import threading
import traceback
import functools
import contextlib
import requests
from typing import Dict, Any, Optional, List, Callable
from datetime import datetime
from queue import Queue
import uuid
import sys
import logging

class TraceContext:
    def __init__(self, name: str, sdk: 'UnravlSDK', parent_span_id: Optional[str] = None):
        self.trace_id = str(uuid.uuid4())
        self.span_id = str(uuid.uuid4())
        self.parent_span_id = parent_span_id
        self.start_time = time.time()
        self.name = name
        self.attributes = {}
        self.events = []
        self.sdk = sdk
        self.ended = False

    def add_event(self, name: str, attributes: Optional[Dict[str, Any]] = None):
        if self.ended:
            return
        self.events.append({
            'name': name,
            'timestamp': time.time(),
            'attributes': attributes or {}
        })

    def set_attribute(self, key: str, value: Any):
        if self.ended:
            return
        self.attributes[key] = value

    def set_attributes(self, attributes: Dict[str, Any]):
        if self.ended:
            return
        self.attributes.update(attributes)

    def end(self):
        if self.ended:
            return
        self.ended = True
        duration = (time.time() - self.start_time) * 1000  # Convert to ms
        self.set_attribute('duration_ms', duration)
        self.sdk._submit_trace(self.to_dict())

    def to_dict(self) -> Dict[str, Any]:
        return {
            'trace_id': self.trace_id,
            'span_id': self.span_id,
            'parent_span_id': self.parent_span_id,
            'start_time': self.start_time,
            'name': self.name,
            'attributes': self.attributes,
            'events': self.events
        }

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type:
            self.set_attribute('error', True)
            self.set_attribute('error_type', exc_type.__name__)
            self.set_attribute('error_message', str(exc_val))
            self.set_attribute('error_traceback', traceback.format_exc())
        self.end()
        return False


class UnravlSDK:
    def __init__(self, project_id: str, api_key: str, endpoint: Optional[str] = None,
                 environment: str = 'production', service_name: str = 'default',
                 batch_size: int = 100, flush_interval: int = 5, debug: bool = False):
        self.project_id = project_id
        self.api_key = api_key
        self.endpoint = endpoint or 'https://api.unravl.io'
        self.environment = environment
        self.service_name = service_name
        self.batch_size = batch_size
        self.flush_interval = flush_interval
        self.debug = debug
        
        self.buffer = Queue()
        self.active_traces = {}
        self.flush_thread = None
        self.running = True
        
        # Set up logging
        self.logger = logging.getLogger('unravl-sdk')
        if debug:
            self.logger.setLevel(logging.DEBUG)
        
        # Start flush thread
        self._start_flush_thread()
        
        # Register shutdown handler
        import atexit
        atexit.register(self.shutdown)

    def trace(self, name: str, parent_span_id: Optional[str] = None) -> TraceContext:
        """Context manager for tracing code blocks"""
        return TraceContext(name, self, parent_span_id)

    def start_trace(self, name: str, parent_span_id: Optional[str] = None) -> TraceContext:
        """Manual trace creation"""
        trace = TraceContext(name, self, parent_span_id)
        self.active_traces[trace.span_id] = trace
        return trace

    def record_metric(self, name: str, value: float, tags: Optional[Dict[str, str]] = None,
                     unit: Optional[str] = None):
        """Record a metric value"""
        metric = {
            'type': 'metric',
            'name': name,
            'value': value,
            'timestamp': time.time(),
            'tags': {
                **(tags or {}),
                'environment': self.environment,
                'service': self.service_name
            },
            'unit': unit
        }
        self._add_to_buffer(metric)

    def report_error(self, error: Exception, context: Optional[Any] = None,
                    severity: Optional[str] = None):
        """Report an error"""
        error_report = {
            'type': 'error',
            'error_type': type(error).__name__,
            'error_message': str(error),
            'timestamp': time.time(),
            'context': {
                **(context or {}),
                'environment': self.environment,
                'service': self.service_name
            },
            'stack_trace': traceback.format_exc(),
            'severity': severity or self._calculate_severity(error)
        }
        self._add_to_buffer(error_report)
        
        # Immediate flush for critical errors
        if severity == 'critical':
            self.flush()

    # Decorators
    def trace_function(self, func: Optional[Callable] = None, name: Optional[str] = None):
        """Decorator to trace function execution"""
        def decorator(f):
            trace_name = name or f"{f.__module__}.{f.__name__}"
            
            @functools.wraps(f)
            def wrapper(*args, **kwargs):
                with self.trace(trace_name) as trace:
                    trace.set_attributes({
                        'function': f.__name__,
                        'module': f.__module__,
                        'args_count': len(args),
                        'kwargs_count': len(kwargs)
                    })
                    return f(*args, **kwargs)
            return wrapper
        
        if func is None:
            return decorator
        return decorator(func)

    def measure_performance(self, func: Optional[Callable] = None, name: Optional[str] = None):
        """Decorator to measure function performance"""
        def decorator(f):
            metric_name = name or f"function.{f.__name__}.duration"
            
            @functools.wraps(f)
            def wrapper(*args, **kwargs):
                start_time = time.time()
                try:
                    result = f(*args, **kwargs)
                    duration = (time.time() - start_time) * 1000
                    self.record_metric(metric_name, duration, 
                                     tags={'function': f.__name__, 'status': 'success'},
                                     unit='ms')
                    return result
                except Exception as e:
                    duration = (time.time() - start_time) * 1000
                    self.record_metric(metric_name, duration,
                                     tags={'function': f.__name__, 'status': 'error'},
                                     unit='ms')
                    raise
            return wrapper
        
        if func is None:
            return decorator
        return decorator(func)

    # Django middleware
    def django_middleware(self, get_response):
        """Django middleware for automatic instrumentation"""
        def middleware(request):
            trace = self.start_trace(f"{request.method} {request.path}")
            
            trace.set_attributes({
                'http.method': request.method,
                'http.path': request.path,
                'http.url': request.build_absolute_uri(),
                'http.user_agent': request.META.get('HTTP_USER_AGENT', ''),
                'http.remote_addr': self._get_client_ip(request),
            })
            
            start_time = time.time()
            
            try:
                response = get_response(request)
                trace.set_attribute('http.status_code', response.status_code)
                trace.set_attribute('http.response_time', (time.time() - start_time) * 1000)
                trace.end()
                return response
            except Exception as e:
                trace.set_attribute('error', True)
                trace.set_attribute('error_message', str(e))
                trace.end()
                self.report_error(e, context={'path': request.path})
                raise
        
        return middleware

    # Flask middleware
    def flask_middleware(self, app):
        """Flask middleware for automatic instrumentation"""
        from flask import request, g
        
        @app.before_request
        def before_request():
            g.unravl_trace = self.start_trace(f"{request.method} {request.path}")
            g.unravl_start_time = time.time()
            
            g.unravl_trace.set_attributes({
                'http.method': request.method,
                'http.path': request.path,
                'http.url': request.url,
                'http.user_agent': request.headers.get('User-Agent', ''),
                'http.remote_addr': request.remote_addr,
            })

        @app.after_request
        def after_request(response):
            if hasattr(g, 'unravl_trace'):
                g.unravl_trace.set_attribute('http.status_code', response.status_code)
                g.unravl_trace.set_attribute('http.response_time', 
                                            (time.time() - g.unravl_start_time) * 1000)
                g.unravl_trace.end()
            return response

        @app.errorhandler(Exception)
        def handle_exception(e):
            if hasattr(g, 'unravl_trace'):
                g.unravl_trace.set_attribute('error', True)
                g.unravl_trace.set_attribute('error_message', str(e))
                g.unravl_trace.end()
            self.report_error(e, context={'path': request.path})
            raise

    # FastAPI middleware
    def fastapi_middleware(self):
        """FastAPI middleware for automatic instrumentation"""
        from fastapi import Request
        from fastapi.responses import Response
        
        async def middleware(request: Request, call_next):
            trace = self.start_trace(f"{request.method} {request.url.path}")
            
            trace.set_attributes({
                'http.method': request.method,
                'http.path': request.url.path,
                'http.url': str(request.url),
                'http.user_agent': request.headers.get('user-agent', ''),
                'http.remote_addr': request.client.host if request.client else None,
            })
            
            start_time = time.time()
            
            try:
                response = await call_next(request)
                trace.set_attribute('http.status_code', response.status_code)
                trace.set_attribute('http.response_time', (time.time() - start_time) * 1000)
                trace.end()
                return response
            except Exception as e:
                trace.set_attribute('error', True)
                trace.set_attribute('error_message', str(e))
                trace.end()
                self.report_error(e, context={'path': request.url.path})
                raise
        
        return middleware

    # Database instrumentation
    def instrument_sqlalchemy(self, engine):
        """Instrument SQLAlchemy engine"""
        from sqlalchemy import event
        
        @event.listens_for(engine, "before_execute")
        def before_execute(conn, clauseelement, multiparams, params, execution_options):
            conn.info['unravl_trace'] = self.start_trace('db.query')
            conn.info['unravl_start_time'] = time.time()
            conn.info['unravl_trace'].set_attributes({
                'db.type': 'sqlalchemy',
                'db.statement': str(clauseelement)[:1000],  # Truncate long queries
            })

        @event.listens_for(engine, "after_execute")
        def after_execute(conn, clauseelement, multiparams, params, execution_options, result):
            if 'unravl_trace' in conn.info:
                trace = conn.info['unravl_trace']
                trace.set_attribute('db.duration_ms', 
                                  (time.time() - conn.info['unravl_start_time']) * 1000)
                trace.set_attribute('db.rows_affected', result.rowcount if hasattr(result, 'rowcount') else 0)
                trace.end()
                del conn.info['unravl_trace']
                del conn.info['unravl_start_time']

        @event.listens_for(engine, "handle_error")
        def handle_error(exception_context):
            if 'unravl_trace' in exception_context.connection.info:
                trace = exception_context.connection.info['unravl_trace']
                trace.set_attribute('error', True)
                trace.set_attribute('error_message', str(exception_context.original_exception))
                trace.end()
                self.report_error(exception_context.original_exception,
                                context={'statement': str(exception_context.statement)[:1000]})

    def instrument_psycopg2(self, connection):
        """Instrument psycopg2 connection"""
        import psycopg2.extensions
        
        original_execute = connection.cursor().__class__.execute
        sdk = self
        
        def execute_wrapper(cursor, query, vars=None):
            trace = sdk.start_trace('db.query')
            trace.set_attributes({
                'db.type': 'postgresql',
                'db.statement': query[:1000] if isinstance(query, str) else str(query)[:1000],
            })
            
            start_time = time.time()
            
            try:
                result = original_execute(cursor, query, vars)
                trace.set_attribute('db.duration_ms', (time.time() - start_time) * 1000)
                trace.set_attribute('db.rows_affected', cursor.rowcount)
                trace.end()
                return result
            except Exception as e:
                trace.set_attribute('error', True)
                trace.set_attribute('error_message', str(e))
                trace.end()
                sdk.report_error(e, context={'query': query[:1000]})
                raise
        
        connection.cursor().__class__.execute = execute_wrapper

    def instrument_pymongo(self, client):
        """Instrument PyMongo client"""
        from pymongo import monitoring
        
        class UnravlCommandListener(monitoring.CommandListener):
            def __init__(self, sdk):
                self.sdk = sdk
                self.traces = {}

            def started(self, event):
                trace = self.sdk.start_trace(f"mongodb.{event.command_name}")
                trace.set_attributes({
                    'db.type': 'mongodb',
                    'db.operation': event.command_name,
                    'db.database': event.database_name,
                    'db.request_id': event.request_id,
                })
                self.traces[event.request_id] = (trace, time.time())

            def succeeded(self, event):
                if event.request_id in self.traces:
                    trace, start_time = self.traces.pop(event.request_id)
                    trace.set_attribute('db.duration_ms', (time.time() - start_time) * 1000)
                    trace.end()

            def failed(self, event):
                if event.request_id in self.traces:
                    trace, start_time = self.traces.pop(event.request_id)
                    trace.set_attribute('error', True)
                    trace.set_attribute('error_message', event.failure)
                    trace.set_attribute('db.duration_ms', (time.time() - start_time) * 1000)
                    trace.end()
                    self.sdk.report_error(Exception(event.failure),
                                        context={'operation': event.command_name})

        listener = UnravlCommandListener(self)
        monitoring.register(listener)

    # Internal methods
    def _submit_trace(self, trace_data: Dict[str, Any]):
        trace_data['type'] = 'trace'
        self._add_to_buffer(trace_data)
        if trace_data.get('span_id') in self.active_traces:
            del self.active_traces[trace_data['span_id']]

    def _add_to_buffer(self, data: Dict[str, Any]):
        self.buffer.put(data)
        
        if self.buffer.qsize() >= self.batch_size:
            self.flush()

    def _start_flush_thread(self):
        def flush_worker():
            while self.running:
                time.sleep(self.flush_interval)
                if not self.buffer.empty():
                    self.flush()
        
        self.flush_thread = threading.Thread(target=flush_worker, daemon=True)
        self.flush_thread.start()

    def flush(self):
        """Manually flush the buffer"""
        if self.buffer.empty():
            return
        
        batch = []
        while not self.buffer.empty() and len(batch) < self.batch_size:
            try:
                batch.append(self.buffer.get_nowait())
            except:
                break
        
        if batch:
            try:
                self._send_batch(batch)
                if self.debug:
                    self.logger.debug(f"Flushed {len(batch)} items")
            except Exception as e:
                if self.debug:
                    self.logger.error(f"Failed to send batch: {e}")
                # Re-add failed batch to buffer
                for item in batch:
                    self.buffer.put(item)

    def _send_batch(self, batch: List[Dict[str, Any]]):
        payload = {
            'project_id': self.project_id,
            'environment': self.environment,
            'service_name': self.service_name,
            'timestamp': time.time(),
            'data': batch
        }
        
        response = requests.post(
            f"{self.endpoint}/api/telemetry/ingest",
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {self.api_key}'
            },
            json=payload,
            timeout=10
        )
        
        if not response.ok:
            raise Exception(f"Failed to send telemetry: {response.status_code} {response.text}")

    def _calculate_severity(self, error: Exception) -> str:
        error_message = str(error).lower()
        
        if 'critical' in error_message or 'fatal' in error_message:
            return 'critical'
        elif 'error' in error_message or 'exception' in error_message:
            return 'high'
        elif 'warning' in error_message or 'warn' in error_message:
            return 'medium'
        else:
            return 'low'

    def _get_client_ip(self, request) -> Optional[str]:
        """Extract client IP from Django request"""
        x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
        if x_forwarded_for:
            return x_forwarded_for.split(',')[0].strip()
        return request.META.get('REMOTE_ADDR')

    def shutdown(self):
        """Shutdown the SDK and flush remaining data"""
        self.running = False
        self.flush()
        if self.flush_thread:
            self.flush_thread.join(timeout=2)


# Convenience function
def create_sdk(project_id: str, api_key: str, **kwargs) -> UnravlSDK:
    return UnravlSDK(project_id, api_key, **kwargs)