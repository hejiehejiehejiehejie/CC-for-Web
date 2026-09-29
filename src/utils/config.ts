import { browser } from './browser';

interface ConfigItems {
  sendToWebPage: boolean;
  sendToLocalTools: boolean;
  customPorts: number[];
  customRules: [string, string][];
  requestTimeout: number;
  debugMode: boolean;
}

class Config {
  private readonly defaults: Partial<ConfigItems> = {
    sendToWebPage: true,
    sendToLocalTools: true,
    customPorts: [],
    customRules: [],
    requestTimeout: 500,
    debugMode: false,
  };

  public async get<T extends keyof ConfigItems>(key: T): Promise<ConfigItems[T]> {
    const data = await browser.storage.local.get(key);
    // 必须用 ??：默认值为 true 的开关存了 false 时，|| 会把 false 当「没设置」而回退成 true
    return (data[key] ?? this.defaults[key]) as ConfigItems[T];
  }

  public set<T extends keyof ConfigItems>(key: T, value: ConfigItems[T]): Promise<void> {
    return browser.storage.local.set({ [key]: value });
  }
}

export const config = new Config();
