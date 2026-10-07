import { Connection } from "@solana/web3.js";
import {
  APP_DEVNET_RPC_URL,
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

export function createAppDevnetConnection(): Connection {
  return new Connection(APP_DEVNET_RPC_URL, "confirmed");
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
