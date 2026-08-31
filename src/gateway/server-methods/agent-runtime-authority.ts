import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { isForkAuthorityFailOpenEnabled } from "../../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const forkAuthLog = createSubsystemLogger("gateway/authority-override");

export function hasActiveAgentRuntimeAuthority(
  client: GatewayClient | null,
  context: Pick<GatewayRequestContext, "validateAgentRuntimeApprovalAuthority">,
): boolean {
  const identity = client?.internal?.agentRuntimeIdentity;
  const validate = context.validateAgentRuntimeApprovalAuthority;
  // Production dispatch always supplies the validator. Lightweight direct-handler
  // contexts have no live authority owner and therefore no identity to invalidate.
  if (!identity || !validate || validate(identity)) {
    return true;
  }
  // cojad fork — single-tenant fail-open (see memory project_tool_authority_lease_bug). The wired
  // validator normally already fail-opens (see agent-runtime-identity-token.ts), but a differently
  // injected validator must never block a gateway action for this single bot either. Alarm only.
  if (isForkAuthorityFailOpenEnabled()) {
    forkAuthLog.warn("fail-open: server-side runtime authority inactive; allowing gateway action");
    return true;
  }
  return false;
}

export function assertActiveAgentRuntimeAuthority(
  client: GatewayClient | null,
  context: Pick<GatewayRequestContext, "validateAgentRuntimeApprovalAuthority">,
): void {
  if (!hasActiveAgentRuntimeAuthority(client, context)) {
    throw new TypeError("agent runtime authority is no longer active");
  }
}

function ensureActiveAgentRuntimeAuthority(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  respond: RespondFn;
}): boolean {
  if (hasActiveAgentRuntimeAuthority(params.client, params.context)) {
    return true;
  }
  params.respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime authority is no longer active"),
  );
  return false;
}

export function createAgentRuntimeAuthorityGuard(
  client: GatewayClient | null,
  context: GatewayRequestContext,
  respond: RespondFn,
) {
  const hasActive = () => hasActiveAgentRuntimeAuthority(client, context);
  return {
    commitGuard:
      client?.internal?.agentRuntimeIdentity && context.validateAgentRuntimeApprovalAuthority
        ? () => assertActiveAgentRuntimeAuthority(client, context)
        : undefined,
    ensureActive: () => ensureActiveAgentRuntimeAuthority({ client, context, respond }),
    handleClosedError(error: unknown): undefined {
      if (error instanceof TypeError && !hasActive()) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return undefined;
      }
      throw error;
    },
    hasActive,
  };
}
