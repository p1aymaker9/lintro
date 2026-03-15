const DEVICE_ID_KEY = 'deviceId';

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function getOrCreateDeviceId(): Promise<string> {
  const result = await browser.storage.local.get(DEVICE_ID_KEY);
  const existing = result[DEVICE_ID_KEY];
  if (isUuid(existing)) {
    return existing;
  }

  const deviceId = crypto.randomUUID();
  await browser.storage.local.set({ [DEVICE_ID_KEY]: deviceId });
  return deviceId;
}