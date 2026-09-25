import { expect, test } from "bun:test";
import { inAppBrowser } from "./in-app-browser";

const IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const ANDROID_WEBVIEW =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.0.0 Mobile Safari/537.36";

test("apps that mark the user agent are named", () => {
  expect(inAppBrowser(`${IOS} Mobile/15E148 [FBAN/FBIOS;FBAV/500.0.0.0]`)).toBe(
    "Facebook",
  );
  expect(
    inAppBrowser(`${IOS} Mobile/15E148 [FBAN/MessengerForiOS;FBAV/500.0]`),
  ).toBe("Messenger");
  expect(
    inAppBrowser(`${ANDROID_WEBVIEW} [FB_IAB/Orca-Android;FBAV/480.0;]`),
  ).toBe("Messenger");
  expect(inAppBrowser(`${ANDROID_WEBVIEW} [FB_IAB/FB4A;FBAV/480.0;]`)).toBe(
    "Facebook",
  );
  expect(
    inAppBrowser(`${IOS} Mobile/15E148 Instagram 380.0.0.0 (iPhone16,2)`),
  ).toBe("Instagram");
  expect(inAppBrowser(`${IOS} Mobile/15E148 Safari Line/14.9.0`)).toBe("LINE");
  expect(inAppBrowser(`${IOS} Mobile/15E148 MicroMessenger/8.0.50`)).toBe(
    "WeChat",
  );
  expect(inAppBrowser(`${IOS} Mobile/15E148 [LinkedInApp]/9.30`)).toBe(
    "LinkedIn",
  );
  expect(inAppBrowser(`${IOS} Mobile/15E148 Twitter for iPhone/10.50`)).toBe(
    "X",
  );
  expect(
    inAppBrowser(`${ANDROID_WEBVIEW} musical_ly_2023 BytedanceWebview/d8a21c6`),
  ).toBe("TikTok");
  expect(
    inAppBrowser(`${IOS} Mobile/15E148 Snapchat/13.40.0.40 (like Safari/8618)`),
  ).toBe("Snapchat");
  // The Google app keeps the Safari token, so only its own mark gives it away.
  expect(inAppBrowser(`${IOS} GSA/380.0.1 Mobile/15E148 Safari/604.1`)).toBe(
    "the Google app",
  );
});

test("unmarked webviews are caught by what they leave out", () => {
  expect(inAppBrowser(ANDROID_WEBVIEW)).toBe("this app");
  expect(inAppBrowser(`${IOS} Mobile/15E148`)).toBe("this app");
});

test("real browsers pass", () => {
  expect(
    inAppBrowser(`${IOS} Version/18.5 Mobile/15E148 Safari/604.1`),
  ).toBeNull();
  expect(
    inAppBrowser(`${IOS} CriOS/138.0.7204.119 Mobile/15E148 Safari/604.1`),
  ).toBeNull();
  expect(
    inAppBrowser(`${IOS} FxiOS/140.0 Mobile/15E148 Safari/605.1.15`),
  ).toBeNull();
  expect(
    inAppBrowser(
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
    ),
  ).toBeNull();
  expect(
    inAppBrowser(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
    ),
  ).toBeNull();
  expect(
    inAppBrowser(
      "Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0",
    ),
  ).toBeNull();
});
