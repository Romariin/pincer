export {};

const childArgs = Bun.argv.slice(2).join(" ");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    return new Response(`<html><head><title>Fixture</title></head><body>fixture app; child args: ${childArgs}</body></html>`, {
      headers: { "content-type": "text/html" },
    });
  },
});

console.log(`Local: http://127.0.0.1:${server.port}/`);

const stop = (): void => {
  server.stop(true);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
