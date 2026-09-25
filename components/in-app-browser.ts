// Apps whose embedded browser marks the user agent, most specific first: Messenger rides FBAN.
const MARKED: [RegExp, string][] = [
  [/FBAN\/Messenger|FB_IAB\/Orca/, "Messenger"],
  [/FBAN|FBAV|FB_IAB/, "Facebook"],
  [/Instagram/, "Instagram"],
  [/\bLine\//, "LINE"],
  [/MicroMessenger/, "WeChat"],
  [/LinkedInApp/, "LinkedIn"],
  [/Twitter/, "X"],
  [/TikTok|musical_ly|BytedanceWebview/, "TikTok"],
  [/Snapchat/, "Snapchat"],
  [/Pinterest/, "Pinterest"],
  [/\bGSA\//, "the Google app"],
];

// Names the app whose embedded browser shows the page, or null for a real browser.
// Only a webview that marks or strips the user agent is caught. An SFSafariViewController
// (Slack, Discord and many others) and an Android Custom Tab send the
// browser's user agent verbatim and expose no script signal, so they read as Safari or Chrome.
export function inAppBrowser(agent: string): string | null {
  const marked = MARKED.find(([pattern]) => pattern.test(agent));
  if (marked) {
    return marked[1];
  } else if (/Android/.test(agent) && /; wv\)/.test(agent)) {
    // Android's WebView flags itself in the platform list.
    return "this app";
  } else if (
    /iPhone|iPad|iPod|Macintosh/.test(agent) &&
    /AppleWebKit/.test(agent) &&
    !/Safari\//.test(agent)
  ) {
    // A bare WKWebView drops the Safari token that Safari and every iOS browser app send.
    // A home-screen launch drops it too, but an installed app never asks how to install.
    return "this app";
  } else {
    return null;
  }
}
