import type { Span } from "@opentelemetry/api";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { OTLPTraceExporter as OTLPGrpcTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as OTLPHttpTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor, ConsoleSpanExporter, SimpleSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildConfig } from "./pi-otel-config.js";
import { setSpanAttributes } from "./pi-otel-attributes.js";
import { EXTENSION_NAME, EXTENSION_VERSION, STATUS_KEY, type Attributes, type RuntimeState } from "./pi-otel-types.js";

export function getParentSpanContext(parent?: Span) {
  return parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT;
}

function createConsoleSpanExporter(state: RuntimeState): SpanExporter {
  const exporter = new ConsoleSpanExporter();
  return {
    export(spans: ReadableSpan[], resultCallback) {
      if (!state.consoleExportEnabled) {
        resultCallback({ code: 0 });
        return;
      }
      exporter.export(spans, resultCallback);
    },
    shutdown() {
      return exporter.shutdown();
    },
    forceFlush() {
      return exporter.forceFlush();
    },
  };
}

export function createRuntime(): RuntimeState {
  const config = buildConfig();
  const state: RuntimeState = {
    config,
    error: !config.enabled ? config.error ?? "Tracing disabled by configuration" : config.error,
    requestSequence: 0,
    uiDetected: false,
    consoleExportEnabled: true,
    eventCounts: {},
    toolSpans: new Map(),
  };

  if (!config.enabled || config.error) {
    return state;
  }

  try {
    const spanProcessors = config.exporters.map((name) => {
      const exporter =
        name === "console"
          ? createConsoleSpanExporter(state)
          : name === "otlp_grpc"
            ? new OTLPGrpcTraceExporter({ url: config.grpcEndpoint })
            : new OTLPHttpTraceExporter({ url: config.httpEndpoint });
      return name === "console" ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter);
    });

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      [ATTR_SERVICE_VERSION]: config.serviceVersion,
      "pi.extension.name": EXTENSION_NAME,
      "pi.extension.version": EXTENSION_VERSION,
      "pi.extension.mode": "hooks",
    });

    const provider = new BasicTracerProvider({
      resource,
      spanProcessors,
    });

    state.provider = provider;
    state.tracer = provider.getTracer(EXTENSION_NAME, EXTENSION_VERSION);
    return state;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    return state;
  }
}

export function syncUiState(state: RuntimeState, hasUI: boolean): void {
  state.uiDetected = state.uiDetected || hasUI;
  state.consoleExportEnabled = !state.uiDetected || state.config.consoleInUi;
}

export function markEvent(state: RuntimeState, name: string): void {
  state.eventCounts[name] = (state.eventCounts[name] ?? 0) + 1;
}

export function setStatusLabel(ctx: ExtensionContext, state: RuntimeState): void {
  if (!ctx.hasUI) return;
  const label = state.error ? "OTel disabled" : `OTel ${state.config.exporterLabel}`;
  ctx.ui.setStatus(STATUS_KEY, label);
}

export function recordStandaloneSpan(state: RuntimeState, name: string, attrs: Attributes): void {
  if (!state.tracer) return;
  const span = state.tracer.startSpan(name);
  setSpanAttributes(span, attrs);
  span.end();
}

export function endToolSpans(state: RuntimeState, reason: string): void {
  for (const [toolCallId, toolState] of state.toolSpans) {
    toolState.span.setStatus({ code: 2, message: reason });
    setSpanAttributes(toolState.span, {
      "pi.tool.call_id": toolCallId,
      "pi.tool.name": toolState.toolName,
      "pi.tool.update_count": toolState.updateCount,
      "pi.tool.orphaned": true,
    });
    toolState.span.end();
  }
  state.toolSpans.clear();
}

export function endTurnSpan(
  state: RuntimeState,
  attrs: Attributes = {},
  status?: { code: number; message?: string },
): void {
  const turn = state.activeTurn;
  if (!turn) return;
  setSpanAttributes(turn.span, {
    "pi.turn.provider_request_count": turn.providerRequestCount,
    "pi.turn.duration_ms": Date.now() - turn.startedAt,
    ...attrs,
  });
  if (turn.firstOutputAt !== undefined) {
    turn.span.setAttribute("pi.turn.first_output_ms", turn.firstOutputAt - turn.startedAt);
  }
  if (status) turn.span.setStatus(status);
  turn.span.end();
  state.activeTurn = undefined;
}

export function endRequestSpan(
  state: RuntimeState,
  attrs: Attributes = {},
  status?: { code: number; message?: string },
): void {
  const request = state.activeRequest;
  if (!request) return;
  endToolSpans(state, "request ended before tool completed");
  endTurnSpan(state, {}, status);
  setSpanAttributes(request.span, {
    "pi.request.duration_ms": Date.now() - request.startedAt,
    "pi.request.provider_request_count": request.providerRequestCount,
    ...attrs,
  });
  if (status) request.span.setStatus(status);
  request.span.end();
  state.activeRequest = undefined;
}
