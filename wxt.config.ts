import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: 'AI Tab Grouper',
    description: 'Group your open tabs with AI. Click the icon, get organized tabs.',
    permissions: ['tabs', 'tabGroups', 'storage'],
    host_permissions: ['https://openrouter.ai/*'],
    // WXT only generates `action` from a popup entrypoint; with no popup (icon-click design) it must be declared here, including default_icon.
    action: {
      default_title: 'Group tabs with AI',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
    },
  },
});
