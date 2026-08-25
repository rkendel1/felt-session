import { expect, test } from "bun:test";
import { responding } from "./bind";

test("waits for the service health check to become ready", async () => {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests += 1;
      return new Response(null, { status: requests < 3 ? 503 : 200 });
    },
  });

  try {
    expect(await responding("127.0.0.1", server.port!, 500, 1)).toBe(true);
    expect(requests).toBe(3);
  } finally {
    server.stop(true);
  }
});
