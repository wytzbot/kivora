import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.kivora.app',
  appName: 'Kivora',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
  },
  server: {
    cleartext: false,
  },
};

export default config;
