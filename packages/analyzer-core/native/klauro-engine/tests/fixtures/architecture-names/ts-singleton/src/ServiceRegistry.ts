export class ServiceRegistry {
  private static instance: ServiceRegistry | undefined;
  static getInstance(): ServiceRegistry {
    this.instance ??= new ServiceRegistry();
    return this.instance;
  }
}
