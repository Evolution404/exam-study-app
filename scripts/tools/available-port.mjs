import net from "node:net";

function validatePort(port, label = "port") {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${label} must be an integer between 0 and 65535, got ${port}`);
  }
}

export async function isPortAvailable(port, host = "127.0.0.1") {
  validatePort(port);
  if (port === 0) return true;
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE" || error?.code === "EACCES") resolve(false);
      else reject(error);
    });
    server.listen(port, host, () => {
      server.close((error) => error ? reject(error) : resolve(true));
    });
  });
}

export async function findAvailablePort(preferredPort = 0, options = {}) {
  const host = options.host ?? "127.0.0.1";
  const maxAttempts = options.maxAttempts ?? 100;
  validatePort(preferredPort, "preferredPort");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error(`maxAttempts must be a positive integer, got ${maxAttempts}`);

  if (preferredPort === 0) {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen(0, host, () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close((error) => error ? reject(error) : resolve(port));
      });
    });
  }

  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = preferredPort + offset;
    if (candidate > 65_535) break;
    if (await isPortAvailable(candidate, host)) return candidate;
  }
  throw new Error(`No available port found from ${preferredPort} after ${maxAttempts} attempts`);
}
