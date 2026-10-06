export class EventBus {
  private handlers: Record<string, Function[]> = {};
  subscribe(event: string, handler: Function) { (this.handlers[event] ??= []).push(handler); }
  unsubscribe(event: string, handler: Function) {}
  emit(event: string, data: any) { (this.handlers[event] || []).forEach(h => h(data)); }
  notify(data: any) {}
}
