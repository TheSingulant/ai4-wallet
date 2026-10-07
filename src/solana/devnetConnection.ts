import { Connection } from "@solana/web3.js";
import {
  APP_DEVNET_RPC_URL,
  RPC_TIMEOUT_MS,
  type GenesisRpc,
} from "../domain/genesisLive";

export interface LatestBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
}

/** Used only while preparing a new transfer. Signing does not call this. */
export interface BlockhashSource {
  getLatestBlockhash(): Promise<LatestBlockhash>;
}

/**
 * Used immediately before a signature request.
 * There is no method here that returns a replacement blockhash.
 */
export interface BlockhashFreshness {
  isBlockhashValid(blockhash: string): Promise<boolean>;
  getBlockHeight(): Promise<number>;
}

/** Literal app DevNet origin. Redirects and other hosts are not this endpoint. */
export function isAppDevnetRpcUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "api.devnet.solana.com" &&
      url.port === "" &&
      (url.pathname === "/" || url.pathname === "") &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export interface DevnetRpcFetchOptions {
  /** Aborts the request when the timer fires. The wait is not abandoned in place. */
  timeoutMs?: number;
  /** Aborted by the caller, including `withTimeout`, so the request stops. */
  signal?: AbortSignal;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * Fetch for the app DevNet RPC.
 * `redirect: "error"` fails closed. A 3xx response is not followed.
 * The timeout aborts the request through AbortController.
 */
export function createDevnetRpcFetch(
  options: DevnetRpcFetchOptions = {},
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  return (input, init) => {
    const url = requestUrl(input);
    if (!isAppDevnetRpcUrl(url)) {
      return Promise.reject(new Error("rpc endpoint is not the app DevNet URL"));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    const parent = init?.signal;
    if (parent) {
      if (parent.aborted) {
        controller.abort();
      } else {
        parent.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }
    if (options.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }
    return fetchImpl(input, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    })
      .then((response) => {
        if (response.status >= 300 && response.status < 400) {
          throw new Error("rpc redirect rejected");
        }
        if (response.redirected) {
          throw new Error("rpc redirect rejected");
        }
        if (response.url !== "" && !isAppDevnetRpcUrl(response.url)) {
          throw new Error("rpc redirect rejected");
        }
        return response;
      })
      .finally(() => {
        clearTimeout(timer);
      });
  };
}

export function createAppDevnetConnection(timeoutMs: number = RPC_TIMEOUT_MS): Connection {
  return new Connection(APP_DEVNET_RPC_URL, {
    commitment: "confirmed",
    fetch: createDevnetRpcFetch({ timeoutMs }),
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

export function genesisRpcFromConnection(connection: Connection): GenesisRpc {
  return {
    getGenesisHash: () => connection.getGenesisHash(),
  };
}

export function blockhashSourceFromConnection(connection: Connection): BlockhashSource {
  return {
    async getLatestBlockhash() {
      const result = await connection.getLatestBlockhash("confirmed");
      return {
        blockhash: result.blockhash,
        lastValidBlockHeight: result.lastValidBlockHeight,
      };
    },
  };
}

export function blockhashFreshnessFromConnection(connection: Connection): BlockhashFreshness {
  return {
    async isBlockhashValid(blockhash: string) {
      const result = await connection.isBlockhashValid(blockhash, { commitment: "confirmed" });
      return result.value === true;
    },
    getBlockHeight: () => connection.getBlockHeight("confirmed"),
  };
}
