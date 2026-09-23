import { createDispatch } from "./dispatch";
import { RoutingEngine } from "./engine";
import type { RouterRequest, RouterResponse } from "./protocol";

// Declared here because the webworker lib redefines DOM types the rest of the app is checked against.
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
