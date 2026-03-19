import { createHash } from "node:crypto";
import type { Span } from "@opentelemetry/api";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  EXTENSION_NAME,
  EXTENSION_VERSION,
  MAX_KEY_COUNT,
  MAX_STRING_ATTRIBUTE_LENGTH,
  type Attributes,
  type PrimitiveAttribute,
  type RuntimeState,
} from "./pi-otel-types.js";

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, current) => {
      if (typeof current === "bigint") return current.toString();
      if (typeof current === "function") return `[function ${current.name || "anonymous"}]`;
      if (current instanceof Error) {
        return {
          name: current.name,
          message: current.message,
          stack: current.stack,
        };
      }
      if (current && typeof current === "object") {
        if (seen.has(current)) return "[circular]";
        seen.add(current);
        if (Array.isArray(current)) return current;
        return Object.fromEntries(Object.entries(current).sort(([left], [right]) => left.localeCompare(right)));
      }
      return current;
    },
    2,
  ) ?? "null";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function lineCount(value: string): number {
  if (value.length === 0) return 0;
  return value.split(/\r?\n/).length;
}

function sanitizeStringAttribute(value: string, maxLength: number): string {
  return truncate(value.replace(/\s+/g, " ").trim(), maxLength);
}

export function summarizeText(prefix: string, value: string, includeRaw: boolean, summaryLength: number): Attributes {
  const normalized = value ?? "";
  const bytes = Buffer.byteLength(normalized, "utf8");
  return {
    [`${prefix}.kind`]: "text",
    [`${prefix}.bytes`]: bytes,
    [`${prefix}.lines`]: lineCount(normalized),
    [`${prefix}.sha256`]: sha256(normalized),
    [`${prefix}.raw`]: includeRaw ? truncate(normalized, summaryLength) : undefined,
  };
}

export function summarizeValue(prefix: string, value: unknown, includeRaw: boolean, summaryLength: number): Attributes {
  const serialized = stableJson(value);
  const attrs: Attributes = {
    [`${prefix}.kind`]: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
    [`${prefix}.bytes`]: Buffer.byteLength(serialized, "utf8"),
    [`${prefix}.sha256`]: sha256(serialized),
    [`${prefix}.raw`]: includeRaw ? truncate(serialized, summaryLength) : undefined,
  };

  if (Array.isArray(value)) {
    attrs[`${prefix}.length`] = value.length;
    return attrs;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    attrs[`${prefix}.key_count`] = keys.length;
    attrs[`${prefix}.keys`] = keys.slice(0, MAX_KEY_COUNT).join(",");

    if (typeof record.model === "string") attrs[`${prefix}.model`] = record.model;
    if (typeof record.provider === "string") attrs[`${prefix}.provider`] = record.provider;
    if (Array.isArray(record.messages)) attrs[`${prefix}.messages`] = record.messages.length;
    if (Array.isArray(record.tools)) attrs[`${prefix}.tools`] = record.tools.length;
    if (typeof record.max_tokens === "number") attrs[`${prefix}.max_tokens`] = record.max_tokens;
    if (typeof record.max_output_tokens === "number") attrs[`${prefix}.max_output_tokens`] = record.max_output_tokens;
  }

  return attrs;
}

function filterAttributes(input: Attributes): Record<string, PrimitiveAttribute> {
  const output: Record<string, PrimitiveAttribute> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      output[key] = sanitizeStringAttribute(value, MAX_STRING_ATTRIBUTE_LENGTH);
      continue;
    }
    output[key] = value;
  }
  return output;
}

export function setSpanAttributes(span: Span | undefined, attrs: Attributes): void {
  if (!span) return;
  span.setAttributes(filterAttributes(attrs));
}

export function addSpanEvent(span: Span | undefined, name: string, attrs: Attributes): void {
  if (!span) return;
  span.addEvent(name, filterAttributes(attrs));
}

export function currentModelAttributes(ctx: ExtensionContext, thinkingLevel: string): Attributes {
  return {
    "pi.cwd": ctx.cwd,
    "pi.session.id": ctx.sessionManager.getSessionId(),
    "pi.session.file": ctx.sessionManager.getSessionFile(),
    "pi.model.provider": ctx.model?.provider,
    "pi.model.id": ctx.model?.id,
    "pi.thinking.level": thinkingLevel,
  };
}

export function summarizeAgentMessages(messages: unknown[]): Attributes {
  const counts: Record<string, number> = {};
  let assistantErrors = 0;
  let toolErrors = 0;

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = typeof (message as { role?: unknown }).role === "string" ? String((message as { role?: unknown }).role) : "unknown";
    counts[role] = (counts[role] ?? 0) + 1;

    if (role === "assistant" && typeof (message as { errorMessage?: unknown }).errorMessage === "string") {
      assistantErrors += 1;
    }
    if (role === "toolResult" && (message as { isError?: unknown }).isError === true) {
      toolErrors += 1;
    }
  }

  return {
    "pi.messages.count": messages.length,
    "pi.messages.user": counts.user ?? 0,
    "pi.messages.assistant": counts.assistant ?? 0,
    "pi.messages.tool_result": counts.toolResult ?? 0,
    "pi.messages.custom": counts.custom ?? 0,
    "pi.messages.assistant_errors": assistantErrors,
    "pi.messages.tool_errors": toolErrors,
  };
}

export function buildStatusLines(state: RuntimeState): string[] {
  const config = state.config;
  return [
    `extension=${EXTENSION_NAME}@${EXTENSION_VERSION}`,
    `enabled=${state.error ? "false" : String(config.enabled)}`,
    `exporters=${config.exporterLabel}`,
    `service.name=${config.serviceName}`,
    `service.version=${config.serviceVersion}`,
    `http.endpoint=${config.httpEndpoint ?? "env/default"}`,
    `grpc.endpoint=${config.grpcEndpoint ?? "env/default"}`,
    `console.in_ui=${config.consoleInUi}`,
    `ui.detected=${state.uiDetected}`,
    `console.export_enabled=${state.consoleExportEnabled}`,
    `capture.prompts=${config.capture.prompts}`,
    `capture.provider_payloads=${config.capture.providerPayloads}`,
    `capture.tool_args=${config.capture.toolArgs}`,
    `capture.tool_results=${config.capture.toolResults}`,
    `summary.length=${config.summaryLength}`,
    `config.sources=${config.configSources.length > 0 ? config.configSources.join(",") : "none"}`,
    `events.session_start=${state.eventCounts.session_start ?? 0}`,
    `events.before_agent_start=${state.eventCounts.before_agent_start ?? 0}`,
    `events.agent_start=${state.eventCounts.agent_start ?? 0}`,
    `events.turn_start=${state.eventCounts.turn_start ?? 0}`,
    `events.before_provider_request=${state.eventCounts.before_provider_request ?? 0}`,
    `events.tool_execution_start=${state.eventCounts.tool_execution_start ?? 0}`,
    `events.turn_end=${state.eventCounts.turn_end ?? 0}`,
    `events.agent_end=${state.eventCounts.agent_end ?? 0}`,
    `active.request=${state.activeRequest ? String(state.activeRequest.sequence) : "none"}`,
    `active.turn=${state.activeTurn ? String(state.activeTurn.index) : "none"}`,
    `active.message=${state.activeMessage ? state.activeMessage.role : "none"}`,
    `active.tools=${state.toolSpans.size}`,
    `pending.session_switch=${state.pendingSessionSwitch ? "yes" : "no"}`,
    `pending.session_fork=${state.pendingSessionFork ? "yes" : "no"}`,
    `pending.session_compact=${state.pendingSessionCompact ? "yes" : "no"}`,
    `pending.session_tree=${state.pendingSessionTree ? "yes" : "no"}`,
    `warnings=${config.warnings.length > 0 ? config.warnings.join(" | ") : "none"}`,
    `error=${state.error ?? "none"}`,
  ];
}
