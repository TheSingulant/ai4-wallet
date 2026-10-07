/**
 * Verify interface stub.
 * Production verification is not implemented and is not called.
 * The only status this module can return is Preview.
 */

export interface VerifyStatus {
  readonly interfaceId: "ai4.verify.preview.v0";
  readonly mode: "preview";
  readonly label: "Preview";
  readonly productionVerifierActive: false;
  readonly productionCalled: false;
  readonly unsWrites: false;
  readonly detail: "Production verifier not active.";
}

export function readVerifyStatus(): VerifyStatus {
  return {
    interfaceId: "ai4.verify.preview.v0",
    mode: "preview",
    label: "Preview",
    productionVerifierActive: false,
    productionCalled: false,
    unsWrites: false,
    detail: "Production verifier not active.",
  };
}
