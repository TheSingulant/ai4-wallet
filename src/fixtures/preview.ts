import type { ConstraintFixture, TransferIntentInput } from "../domain/types";

/** Public DevNet destination from the ai4-constrain DevNet E2E note. Not a secret. */
export const FIXTURE_DESTINATION = "4WDYrTNTit9m7kU5y2LWCfvf35pQo9vbjPTDyiDHEq9e";

/** System program id. Used only as a different destination in mismatch checks. */
export const ALT_DESTINATION = "11111111111111111111111111111111";

export const DEVNET_TRANSFER: TransferIntentInput = {
  network: "devnet",
  asset: "SOL",
  action: "transfer",
  amount: "0.001",
  destination: FIXTURE_DESTINATION,
};

export const CONSTRAINT_FIXTURES: Record<"allow" | "revise" | "refuse", ConstraintFixture> = {
  allow: {
    id: "preview-allow",
    decision: "ALLOW",
    reasons: ["fixture constraint decision is ALLOW"],
  },
  revise: {
    id: "preview-revise",
    decision: "REVISE",
    reasons: ["fixture constraint decision is REVISE"],
  },
  refuse: {
    id: "preview-refuse",
    decision: "REFUSE",
    reasons: ["fixture constraint decision is REFUSE"],
  },
};

export const KNOWN_BINDING_JSON =
  '{"action":"transfer","amount_sol":"0.001","asset":"SOL","destination":"4WDYrTNTit9m7kU5y2LWCfvf35pQo9vbjPTDyiDHEq9e","lamports":1000000,"network":"devnet"}';

export const KNOWN_BINDING_SHA256 =
  "fe30e76ac25e766f37d4f719caaa7efa7b2603afbf388dbca609154258a37da0";
