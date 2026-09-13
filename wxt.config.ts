import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: 'Onekey Tab',
    description: 'Group your open tabs with AI. Click the icon, get organized tabs.',
    permissions: ['tabs', 'tabGroups', 'storage'],
    host_permissions: ['https://openrouter.ai/*'],
    // Icons are generated from assets/icon.svg by @wxt-dev/auto-icons at build time;
    // Chrome falls back to manifest.icons for the action icon when default_icon is absent.
    action: {
      default_title: 'Group tabs with AI',
    },
  },
  modules: ['@wxt-dev/auto-icons'],
  autoIcons: {
    baseIconPath: 'assets/icon.svg',
  },
});
