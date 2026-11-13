import { channel } from "node:diagnostics_channel";

/** Payload-blind owned-process observation; never an authorization primitive. */
export function observeOutgoingHttp() {
  let count = 0,
    closed = false;
  const channels = [
    channel("undici:request:create"),
    channel("http.client.request.start"),
  ];
  const observe = () => {
    count = Math.min(1000000, count + 1);
  };
  for (const item of channels) item.subscribe(observe);
  return Object.freeze({
    get count() {
      return count;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const item of channels) item.unsubscribe(observe);
    },
  });
}
