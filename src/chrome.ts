import fetch from 'node-fetch';

export async function getChromeWebSocketDebuggerURL(dev: boolean) {
  const config = dev ? require('../.config.js') : require('./.config.js');

  const CHROME_ADDRESS = config.chromeAddress;
  const CHROME_USERNAME = config.chromeUsername;
  const CHROME_PASSWORD = config.chromePassword;

  let authorization = `Basic ${Buffer.from(
    `${CHROME_USERNAME}:${CHROME_PASSWORD}`,
  ).toString('base64')}`;

  let chromeVersionResponse = await fetch(`${CHROME_ADDRESS}/json/version`, {
    headers: {
      Authorization: authorization,
    },
    timeout: 10000,
  });

  let chromeVersion = await chromeVersionResponse.json();

  let wsURL = new URL(chromeVersion.webSocketDebuggerUrl);

  wsURL.protocol = 'wss';
  wsURL.hostname = new URL(CHROME_ADDRESS).hostname;
  wsURL.username = CHROME_USERNAME;
  wsURL.password = CHROME_PASSWORD;

  return wsURL.href;
}
