// Doctor helpers for installing plugins required by configured agent runtimes.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  collectConfiguredAgentHarnessRuntimes,
  type ConfiguredAgentHarnessRuntimeOptions,
} from "../../../agents/harness-runtimes.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginPackageInstall } from "../../../plugins/manifest.js";

type ConfiguredRuntimePluginInstallCandidate = {
  /** Runtime/plugin id used in config and plugin installation records. */
  pluginId: string;
  /** Human-readable plugin label for prompts and notes. */
  label: string;
  /** npm package spec for an official runtime plugin install. */
  npmSpec?: string;
  /** ClawHub install spec when the runtime plugin is sourced from ClawHub. */
  clawhubSpec?: string;
  /** True when the install source is trusted to link official runtime support. */
  trustedSourceLinkedOfficialInstall?: boolean;
  /** Default installer choice when multiple official sources are available. */
  defaultChoice?: PluginPackageInstall["defaultChoice"];
  /** Keep this official runtime package on the same release cohort as OpenClaw. */
  versionBoundToOpenClaw?: boolean;
};

export const CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES: readonly ConfiguredRuntimePluginInstallCandidate[] =
  [
    {
      pluginId: "acpx",
      label: "ACPX Runtime",
      npmSpec: "@openclaw/acpx",
      trustedSourceLinkedOfficialInstall: true,
    },
    // Runtime-only configs do not have a provider/channel integration catalog entry.
    // cojad fork: codex is NOT version-bound to core. Upstream pins codex to the
    // exact core release cohort, but our date-tag core versions (e.g. 2608.x) and
    // beta cores can run ahead of the newest published @openclaw/codex, so binding
    // makes doctor re-refresh codex every boot — the migration fingerprint never
    // settles and the gateway crash-loops with "migration inputs changed during
    // startup convergence". Unbinding lets codex resolve @beta and converge.
    {
      pluginId: "codex",
      label: "Codex",
      // cojad fork: pin codex to the cohort compatible with this core's SDK. Unbound
      // @beta drifted to 2026.9.x which needs a newer plugin-sdk than this core ships
      // (clean-install churn: codex doctor-contract imports 'isPathInside' the core
      // does not export -> startup migration never settles). 2026.7.2-beta.7 is what
      // the shipped 2608.x image runs. Repin when the core is upgraded to a newer cohort.
      npmSpec: "@openclaw/codex@2026.7.2-beta.7",
      trustedSourceLinkedOfficialInstall: true,
    },
  ];

export const VERSION_BOUND_RUNTIME_PLUGIN_IDS: ReadonlySet<string> = new Set(
  CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES.filter(
    (candidate) => candidate.versionBoundToOpenClaw,
  ).map((candidate) => candidate.pluginId),
);

export const VERSION_BOUND_RUNTIME_PLUGIN_POLICY_IDS_BY_SURFACE = {
  allow: VERSION_BOUND_RUNTIME_PLUGIN_IDS,
  deny: VERSION_BOUND_RUNTIME_PLUGIN_IDS,
  entries: VERSION_BOUND_RUNTIME_PLUGIN_IDS,
} as const;

/** Resolve the official install candidate for a configured runtime id. */
export function resolveConfiguredRuntimePluginInstallCandidate(
  runtimeId: string,
): ConfiguredRuntimePluginInstallCandidate | undefined {
  return CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES.find(
    (candidate) => candidate.pluginId === runtimeId,
  );
}

function acpxRuntimeIsConfigured(cfg: OpenClawConfig): boolean {
  const acp = asOptionalRecord(cfg.acp);
  const backend = typeof acp?.backend === "string" ? acp.backend.trim().toLowerCase() : "";
  return (
    (backend === "acpx" ||
      acp?.enabled === true ||
      asOptionalRecord(acp?.dispatch)?.enabled === true) &&
    (!backend || backend === "acpx")
  );
}

/** Collect runtime plugin ids implied by configured harness runtimes and ACPX settings. */
export function collectConfiguredRuntimePluginIds(
  cfg: OpenClawConfig,
  options?: ConfiguredAgentHarnessRuntimeOptions,
): string[] {
  const ids = new Set(collectConfiguredAgentHarnessRuntimes(cfg, options));
  if (acpxRuntimeIsConfigured(cfg)) {
    ids.add("acpx");
  }
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}
