import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'org.offgrid.navigation',
  appName: 'OFFGRID',
  webDir: 'dist',
  loggingBehavior: 'none',
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
    backgroundColor: '#f5f4ed',
    minWebViewVersion: 117,
  },
};

export default config;
