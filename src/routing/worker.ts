import { createDispatch } from "./dispatch";
import { RoutingEngine } from "./engine";
import type { RouterRequest, RouterResponse } from "./protocol";

// Stated here rather than pulled in with the webworker lib, which redefines DOM types the rest of
// the app is checked against.
interface RouterScope {
  postMessage(response: RouterResponse): void;
  onmessage: ((event: MessageEvent<RouterRequest>) => void) | null;
}

const scope = self as unknown as RouterScope;
const dispatch = createDispatch(new RoutingEngine(), (response) =>
  scope.postMessage(response),
);

scope.onmessage = (event: MessageEvent<RouterRequest>): void => {
  void dispatch.receive(event.data);
};
