import type { INestApplicationContext } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import type { ServerOptions } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";

/**
 * Socket.IO adapter backed by Redis pub/sub so broadcasts (`server.emit` /
 * `server.to(room)`) fan OUT across all load-balanced WS nodes (Phase 4.1). The
 * single engine leader's emits reach clients connected to ANY node — the
 * prerequisite for horizontal scale.
 *
 * Owns a DEDICATED pub/sub connection pair: the subscriber enters subscribe mode
 * and can't run normal commands, so it must NOT share the app's
 * `RedisService.client`. Built self-contained from `REDIS_URL` rather than from
 * `RedisService`, because at bootstrap time (before `app.listen()`) the module
 * `onModuleInit` hasn't run yet, so `RedisService.client` may not exist.
 *
 * Graceful degradation: `connect()` probes Redis with a bounded timeout; if Redis
 * is absent/unreachable (local dev, CI, a single node without Redis) it THROWS and
 * the caller falls back to the stock in-memory `IoAdapter` — byte-for-byte the
 * current single-node behavior. On a single node the pub/sub channel simply has no
 * other subscribers, so every emit behaves exactly as today.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly log = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(
    app: INestApplicationContext,
    private readonly url: string,
    private readonly probeTimeoutMs = 2000,
  ) {
    super(app);
  }

  /**
   * Probe Redis and build the adapter factory. Resolves when the dedicated
   * pub/sub pair is connected; THROWS (after disconnecting the probes) if Redis
   * is unreachable within `probeTimeoutMs`, so the caller degrades to in-memory.
   */
  async connect(): Promise<void> {
    // lazyConnect → an explicit connect() we can race against a timeout. Default
    // retryStrategy is kept for RUNTIME auto-reconnect after a transient blip;
    // the timeout below is what bounds the BOOT probe when Redis is truly absent.
    const pub = new Redis(this.url, { lazyConnect: true });
    const sub = new Redis(this.url, { lazyConnect: true });
    // A transient client error must never crash the process — log and let ioredis
    // auto-reconnect. (Without a handler, ioredis 'error' events throw.) Capture
    // the FIRST error so the degradation log surfaces the real cause (e.g.
    // ECONNREFUSED) rather than the "Connection is closed." artifact that
    // disconnect() produces when it aborts the in-flight connect().
    let firstError: Error | undefined;
    const onErr = (who: string) => (e: Error) => {
      if (!firstError) firstError = e;
      this.log.warn(`${who}: ${e.message}`);
    };
    pub.on("error", onErr("pub"));
    sub.on("error", onErr("sub"));
    try {
      await this.withTimeout(Promise.all([pub.connect(), sub.connect()]), this.probeTimeoutMs);
      this.pubClient = pub;
      this.subClient = sub;
      this.adapterConstructor = createAdapter(pub, sub);
    } catch (e) {
      // Stop the reconnection loops on the throwaway probes before bubbling up.
      pub.disconnect();
      sub.disconnect();
      throw firstError ?? e; // prefer the original connection error over the disconnect artifact
    }
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options); // preserves CORS + all server options
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
      this.log.log("Socket.IO Redis adapter active (multi-node fan-out enabled)");
    }
    return server;
  }

  /** Whether the Redis-backed adapter is active (vs. degraded to in-memory). */
  get active(): boolean {
    return this.adapterConstructor !== undefined;
  }

  /** Close the dedicated pub/sub clients (graceful shutdown / tests). */
  async dispose(): Promise<void> {
    await Promise.all([
      this.pubClient?.quit().catch(() => undefined),
      this.subClient?.quit().catch(() => undefined),
    ]);
    this.pubClient = undefined;
    this.subClient = undefined;
  }

  /** Race a promise against a timeout; the timer is always cleared. */
  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      p.finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`redis probe timeout after ${ms}ms`)), ms);
      }),
    ]);
  }
}
