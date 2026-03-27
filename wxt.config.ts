import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Lintro-AI Language Learning for Video Subtitles',
    permissions: [
      'storage',
      'offscreen',
      'declarativeNetRequest',
      'declarativeNetRequestWithHostAccess',
    ],
    host_permissions: [
      '*://*.youtube.com/*',
      '*://*.bilibili.com/*',
    ],
    declarative_net_request: {
      rule_resources: [
        {
          id: 'subtitle_rules',
          enabled: true,
          path: 'rules/subtitle-rules.json',
        }
      ]
    },
    web_accessible_resources: [
      {
        resources: ['extractor.js'],
        matches: ['*://*.youtube.com/*', '*://*.bilibili.com/*'],
      }
    ]
  }
});
