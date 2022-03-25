import fetch from 'node-fetch';

export async function getChromeWebSocketDebuggerURL(dev: boolean) {
  const config = dev ? require('../.config.dev.js') : require('./.config.js');

  const CHROME_ADDRESS = config.chromeAddress;
  const CHROME_USERNAME = config.chromeUsername;
  const CHROME_PASSWORD = config.chromePassword;

  let authorization =
    CHROME_USERNAME || CHROME_PASSWORD
      ? `Basic ${Buffer.from(`${CHROME_USERNAME}:${CHROME_PASSWORD}`).toString(
          'base64',
        )}`
      : undefined;

  let chromeVersionResponse = await fetch(`${CHROME_ADDRESS}/json/version`, {
    headers: authorization
      ? {
          Authorization: authorization,
        }
      : undefined,
    timeout: 10000,
  });

  let chromeVersion = await chromeVersionResponse.json();

  let chromeURL = new URL(CHROME_ADDRESS);
  let wsURL = new URL(chromeVersion.webSocketDebuggerUrl);

  if (chromeURL.protocol === 'https:') {
    wsURL.protocol = 'wss';
  }

  wsURL.hostname = chromeURL.hostname;
  wsURL.username = CHROME_USERNAME;
  wsURL.password = CHROME_PASSWORD;

  return wsURL.href;
}
