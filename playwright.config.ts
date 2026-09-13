import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // A failing run should leave something to look at; a passing one should leave
    // nothing (both directories are gitignored).
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'mobile-360',
      use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 740 }, isMobile: false, hasTouch: true },
    },
    {
      name: 'mobile-390',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: false, hasTouch: true },
    },
  ],
  webServer: {
    command: `npm run build && npm run start -- --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: { MORRIS_E2E: '1', PORT: String(PORT) },
  },
});
