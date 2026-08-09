import { PassThrough, Readable, Writable } from "node:stream";

type NodeHandler = (req: Readable, res: Writable) => void | Promise<void>;
interface ExpressLike {
  handle(req: unknown, res: unknown): void;
}

function bindOwnMethods(target: Record<string, unknown>, names: string[]): void {
  for (const name of names) {
    const value = target[name];
    if (typeof value === "function") {
      target[name] = value.bind(target);
    }
  }
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const h = new Headers(headers);
  for (const [key, value] of h) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

async function bodyToBuffer(body: BodyInit | null | undefined): Promise<Buffer> {
  if (body == null) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  throw new Error(`Unsupported in-process request body: ${Object.prototype.toString.call(body)}`);
}

export function createNodeHandlerFetch(
  handler: NodeHandler,
  baseUrl = "http://in-process.local",
): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestUrl =
      typeof input === "string" || input instanceof URL
        ? new URL(input, baseUrl)
        : new URL(input.url);
    const method =
      init?.method ??
      (input instanceof Request ? input.method : undefined) ??
      "GET";
    const headers = normalizeHeaders(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const body = await bodyToBuffer(init?.body);
    if (body.length > 0 && headers["content-length"] === undefined) {
      headers["content-length"] = body.length.toString();
    }

    let bodySent = false;
    const req = new Readable({
      read() {
        if (bodySent) return;
        bodySent = true;
        if (body.length > 0) this.push(body);
        this.push(null);
      },
    }) as Readable & {
      method: string;
      url: string;
      headers: Record<string, string>;
      socket: PassThrough & { encrypted: boolean; remoteAddress: string };
      connection: PassThrough & { encrypted: boolean; remoteAddress: string };
    };
    req.method = method;
    req.url = `${requestUrl.pathname}${requestUrl.search}`;
    req.headers = headers;
    req.socket = new PassThrough() as PassThrough & {
      encrypted: boolean;
      remoteAddress: string;
    };
    req.socket.encrypted = false;
    req.socket.remoteAddress = "127.0.0.1";
    req.connection = req.socket;
    bindOwnMethods(req as unknown as Record<string, unknown>, [
      "on",
      "once",
      "emit",
      "removeListener",
      "read",
      "resume",
      "pause",
      "pipe",
      "unpipe",
      "destroy",
    ]);

    return await new Promise<Response>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const responseHeaders = new Headers();
      let ended = false;
      let headersSent = false;
      let writableEnded = false;

      const res = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          callback();
        },
      }) as Writable & Record<string, unknown>;

      const setHeader = (name: string, value: number | string | readonly string[]) => {
        if (Array.isArray(value)) responseHeaders.set(name, value.join(", "));
        else responseHeaders.set(name, String(value));
      };
      res["statusCode"] = 200;
      res["statusMessage"] = "OK";
      Object.defineProperty(res, "headersSent", {
        configurable: true,
        get: () => headersSent,
        set: (value: boolean) => {
          headersSent = value;
        },
      });
      Object.defineProperty(res, "writableEnded", {
        configurable: true,
        get: () => writableEnded,
        set: (value: boolean) => {
          writableEnded = value;
        },
      });
      res["locals"] = {};
      res["setHeader"] = setHeader;
      res["getHeader"] = (name: string) => responseHeaders.get(name);
      res["getHeaders"] = () => Object.fromEntries(responseHeaders.entries());
      res["removeHeader"] = (name: string) => responseHeaders.delete(name);
      res["writeHead"] = (
        status: number,
        statusMessageOrHeaders?: string | Record<string, number | string | readonly string[]>,
        headersArg?: Record<string, number | string | readonly string[]>,
      ) => {
        res["statusCode"] = status;
        const headersToSet =
          typeof statusMessageOrHeaders === "object"
            ? statusMessageOrHeaders
            : headersArg;
        if (headersToSet) {
          for (const [key, value] of Object.entries(headersToSet)) {
            setHeader(key, value);
          }
        }
        headersSent = true;
        return res;
      };
      Object.defineProperty(res, "write", {
        configurable: true,
        value: (
        chunk: unknown,
        encodingOrCallback?: BufferEncoding | (() => void),
        callback?: () => void,
      ) => {
          headersSent = true;
          if (chunk !== undefined) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          }
          const cb =
            typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
          cb?.();
          return true;
        },
      });
      Object.defineProperty(res, "end", {
        configurable: true,
        value: (
        chunk?: unknown,
        encodingOrCallback?: BufferEncoding | (() => void),
        callback?: () => void,
      ) => {
          if (ended) return res;
          ended = true;
          headersSent = true;
          writableEnded = true;
          if (chunk !== undefined) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          }
          const cb =
            typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
          cb?.();
          res.emit("finish");
          resolve(
            new Response(Buffer.concat(chunks), {
              status: Number(res["statusCode"]),
              headers: responseHeaders,
            }),
          );
          return res;
        },
      });
      bindOwnMethods(res as unknown as Record<string, unknown>, [
        "on",
        "once",
        "emit",
        "removeListener",
        "cork",
        "uncork",
        "destroy",
      ]);

      try {
        Promise.resolve(handler(req, res)).catch(reject);
      } catch (err) {
        reject(err);
      }
    });
  };
}

export function createExpressFetch(
  app: ExpressLike,
  baseUrl = "http://in-process.local",
): typeof fetch {
  return createNodeHandlerFetch(
    (req, res) => {
      app.handle(req as never, res as never);
    },
    baseUrl,
  );
}
