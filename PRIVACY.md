# Privacy Policy / 隐私政策

Last updated: 2026-03-15

## Summary (English)
Lintro is a browser extension that adds bilingual subtitles and optional AI-powered analysis on YouTube and Bilibili.

- **Local-only settings**: Your configuration (including any API key you paste) is stored in your browser’s extension storage and is **not** sent to us.
- **Content you choose to process**: Subtitle text and analysis requests are sent to the translation service / LLM endpoint you selected so it can return results.
- **Free trial**: If you use the built-in free trial analysis, the extension sends a **randomly generated device identifier** (UUID) to our trial API to enforce daily quota and prevent abuse.

## 概要（中文）
Lintro 是一个浏览器扩展，用于在 YouTube 和 Bilibili 上展示双语字幕，并提供可选的 AI 语法/句子分析。

- **本地保存配置**：你的配置（包括你粘贴的 API Key）仅保存在浏览器扩展的本地存储中，**不会上传给我们**。
- **你选择处理的内容**：字幕文本与分析请求会发送到你选择的翻译服务 / 大模型接口，以便获取翻译或分析结果。
- **免费试用**：当你使用内置的免费试用分析时，扩展会向我们的试用接口发送一个**随机生成的设备标识**（UUID），用于每日配额控制与滥用防护。

---

## 1) Data We Process / 我们处理的数据

### A. Data stored locally / 本地存储
Stored in `browser.storage.local` on your device:

- Extension settings (languages, UI preferences, hotkeys)
- API profiles you configure (provider, endpoint URL, model, and **API key**)
- Prompt bundle cache (downloaded prompt text)
- Capability cache (e.g., whether a model supports certain parameters)
- **Device identifier** for the free trial feature (UUID)

We do not have access to this local storage unless you share it with us.

### B. Data sent over the network / 网络传输数据
Depending on the features you enable:

- **Translation**: Subtitle text may be sent to:
  - Google Translate public endpoint (if you choose Google Translate)
  - Microsoft Translator endpoints (if you choose Microsoft Translate)
  - Your selected LLM endpoint (if you choose LLM translation)
- **AI analysis**: The sentence text (and optional context) is sent to:
  - Your selected LLM endpoint, or
  - Our trial API (only when using the built-in free trial analysis)
- **Free trial metadata**: When calling the trial API, the extension sends:
  - A random device identifier (UUID)
  - The extension version

## 2) What We Don’t Collect / 我们不收集的内容

- We do **not** collect your browsing history.
- We do **not** sell your data.
- We do **not** receive or store the API keys you enter; they stay local on your device.

## 3) Third-Party Services / 第三方服务
When you enable related features, your requested text may be processed by third-party services you select (e.g., Google Translate, Microsoft Translator, OpenAI-compatible model providers, or a custom endpoint). Their handling of data is governed by their own privacy policies.

## 4) Data Retention / 数据保留

- **On your device**: Data remains until you clear the extension’s storage or uninstall the extension.
- **Trial API**: We aim to minimize server-side data. Like most online services, our hosting provider may keep standard server logs (e.g., request time, status code) for operational and abuse-prevention purposes.

## 5) Your Choices / 你的选择

- You can disable translation/analysis features at any time in the extension popup.
- You can delete local data by removing the extension or clearing the extension’s site/extension storage.

## 6) Contact / 联系方式

For questions or requests, please open an issue on:
https://github.com/p1aymaker9/lintro
