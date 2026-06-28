export class ConfigManager {
  private static instance: ConfigManager;
  private settings: Record<string, string> = {};
  private constructor() {}
  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }
  get(key: string) { return this.settings[key]; }
}
