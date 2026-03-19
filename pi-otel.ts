import { SpanStatusCode } from "@opentelemetry/api";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  addSpanEvent,
  buildStatusLines,
  currentModelAttributes,
  setSpanAttributes,
  summarizeAgentMessages,
  summarizeText,
  summarizeValue,
} from "./lib/pi-otel-attributes.js";
import { createRuntime, endRequestSpan, endTurnSpan, getParentSpanContext, markEvent, recordStandaloneSpan, setStatusLabel, syncUiState } from "./lib/pi-otel-runtime.js";

export default function (pi: ExtensionAPI) {
  const state = createRuntime();
  const syncRuntimeUiState = (hasUI: boolean) => syncUiState(state, hasUI);

  pi.registerCommand("otel-status", {
    description: "Show pi-otel tracing configuration and runtime state",
    handler: async (_args, ctx) => {
      syncRuntimeUiState(ctx.hasUI);
      const text = buildStatusLines(state).join("\n");
      if (ctx.hasUI) {
        ctx.ui.notify(text, state.error ? "warning" : "info");
        return;
      }
      console.log(text);
    },
  });

  pi.registerCommand("otel-flush", {
    description: "Force-flush pending spans",
    handler: async (_args, ctx) => {
      syncRuntimeUiState(ctx.hasUI);
      if (!state.provider) {
        const message = state.error ?? "Tracer provider is not active";
        if (ctx.hasUI) {
          ctx.ui.notify(message, "warning");
          return;
        }
        console.log(message);
        return;
      }
      await state.provider.forceFlush();
      if (ctx.hasUI) {
        ctx.ui.notify("OTel spans flushed", "info");
        return;
      }
      console.log("OTel spans flushed");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    markEvent(state, "session_start");
    syncRuntimeUiState(ctx.hasUI);
    setStatusLabel(ctx, state);
    recordStandaloneSpan(state, "pi.session_start", {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.exporters": state.config.exporterLabel,
    });
  });

  pi.on("session_switch", async (event, ctx) => {
    syncRuntimeUiState(ctx.hasUI);
    setStatusLabel(ctx, state);
    recordStandaloneSpan(state, "pi.session_switch", {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.session.reason": event.reason,
      "pi.session.previous_file": event.previousSessionFile,
    });
  });

  pi.on("session_fork", async (event, ctx) => {
    syncRuntimeUiState(ctx.hasUI);
    recordStandaloneSpan(state, "pi.session_fork", {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.session.previous_file": event.previousSessionFile,
    });
  });

  pi.on("session_tree", async (event, ctx) => {
    syncRuntimeUiState(ctx.hasUI);
    recordStandaloneSpan(state, "pi.session_tree", {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.session.new_leaf_id": event.newLeafId ?? undefined,
      "pi.session.old_leaf_id": event.oldLeafId ?? undefined,
      "pi.session.has_summary": Boolean(event.summaryEntry),
      "pi.session.from_extension": Boolean(event.fromExtension),
    });
  });

  pi.on("session_compact", async (event, ctx) => {
    syncRuntimeUiState(ctx.hasUI);
    recordStandaloneSpan(state, "pi.session_compact", {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.compaction.from_extension": event.fromExtension,
      "pi.compaction.tokens_before": event.compactionEntry.tokensBefore,
      "pi.compaction.first_kept_entry_id": event.compactionEntry.firstKeptEntryId,
    });
  });

  pi.on("model_select", async (event, ctx) => {
    syncRuntimeUiState(ctx.hasUI);
    const attrs = {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.model.previous_provider": event.previousModel?.provider,
      "pi.model.previous_id": event.previousModel?.id,
      "pi.model.source": event.source,
    };

    if (state.activeRequest) {
      addSpanEvent(state.activeRequest.span, "model_select", attrs);
      return;
    }

    recordStandaloneSpan(state, "pi.model_select", attrs);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    markEvent(state, "before_agent_start");
    syncRuntimeUiState(ctx.hasUI);
    if (!state.tracer) return;

    endRequestSpan(
      state,
      {
        "pi.request.orphaned": true,
      },
      {
        code: SpanStatusCode.ERROR,
        message: "replaced by a newer request",
      },
    );

    state.requestSequence += 1;
    const requestSpan = state.tracer.startSpan("pi.request");
    setSpanAttributes(requestSpan, {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.request.sequence": state.requestSequence,
      "pi.request.image_count": event.images?.length ?? 0,
      ...summarizeText("pi.prompt", event.prompt, state.config.capture.prompts, state.config.summaryLength),
    });

    state.activeRequest = {
      span: requestSpan,
      sequence: state.requestSequence,
      startedAt: Date.now(),
      providerRequestCount: 0,
    };
  });

  pi.on("agent_start", async (_event, ctx) => {
    markEvent(state, "agent_start");
    syncRuntimeUiState(ctx.hasUI);
    if (!state.activeRequest) return;
    addSpanEvent(state.activeRequest.span, "agent_start", currentModelAttributes(ctx, pi.getThinkingLevel()));
  });

  pi.on("turn_start", async (event, ctx) => {
    markEvent(state, "turn_start");
    syncRuntimeUiState(ctx.hasUI);
    if (!state.tracer) return;
    const turnSpan = state.tracer.startSpan("pi.turn", {}, getParentSpanContext(state.activeRequest?.span));
    setSpanAttributes(turnSpan, {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.turn.index": event.turnIndex,
      "pi.turn.timestamp": event.timestamp,
    });

    state.activeTurn = {
      span: turnSpan,
      index: event.turnIndex,
      startedAt: Date.now(),
      providerRequestCount: 0,
    };
  });

  pi.on("before_provider_request", async (event) => {
    markEvent(state, "before_provider_request");
    const target = state.activeTurn?.span ?? state.activeRequest?.span;
    if (!target) return;

    if (state.activeRequest) state.activeRequest.providerRequestCount += 1;
    if (state.activeTurn) state.activeTurn.providerRequestCount += 1;

    addSpanEvent(target, "provider.request", {
      "pi.provider.request.index": state.activeRequest?.providerRequestCount,
      ...summarizeValue(
        "pi.provider.request",
        event.payload,
        state.config.capture.providerPayloads,
        state.config.summaryLength,
      ),
    });
  });

  pi.on("message_update", async (event) => {
    if (!state.activeTurn || state.activeTurn.firstOutputAt !== undefined) return;
    const eventType = event.assistantMessageEvent.type;
    if (eventType.endsWith("_delta") || eventType.endsWith("_start") || eventType.endsWith("_end")) {
      state.activeTurn.firstOutputAt = Date.now();
      addSpanEvent(state.activeTurn.span, "turn.first_output", {
        "pi.turn.first_output_event": eventType,
      });
    }
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    markEvent(state, "tool_execution_start");
    syncRuntimeUiState(ctx.hasUI);
    if (!state.tracer) return;
    const toolSpan = state.tracer.startSpan(
      "pi.tool",
      {},
      getParentSpanContext(state.activeTurn?.span ?? state.activeRequest?.span),
    );
    setSpanAttributes(toolSpan, {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.tool.name": event.toolName,
      "pi.tool.call_id": event.toolCallId,
      ...summarizeValue("pi.tool.args", event.args, state.config.capture.toolArgs, state.config.summaryLength),
    });

    state.toolSpans.set(event.toolCallId, {
      span: toolSpan,
      toolName: event.toolName,
      startedAt: Date.now(),
      updateCount: 0,
    });
  });

  pi.on("tool_execution_update", async (event) => {
    const toolState = state.toolSpans.get(event.toolCallId);
    if (!toolState) return;
    toolState.updateCount += 1;

    if (toolState.updateCount === 1) {
      addSpanEvent(toolState.span, "tool.update", {
        "pi.tool.partial.kind": Array.isArray(event.partialResult) ? "array" : typeof event.partialResult,
      });
    }
  });

  pi.on("tool_execution_end", async (event) => {
    const toolState = state.toolSpans.get(event.toolCallId);
    if (!toolState) return;

    setSpanAttributes(toolState.span, {
      "pi.tool.duration_ms": Date.now() - toolState.startedAt,
      "pi.tool.update_count": toolState.updateCount,
      "pi.tool.is_error": event.isError,
      ...summarizeValue("pi.tool.result", event.result, state.config.capture.toolResults, state.config.summaryLength),
    });

    if (event.isError) {
      toolState.span.setStatus({ code: SpanStatusCode.ERROR, message: "tool execution failed" });
    }

    toolState.span.end();
    state.toolSpans.delete(event.toolCallId);
  });

  pi.on("turn_end", async (event) => {
    markEvent(state, "turn_end");
    if (!state.activeTurn) return;

    const message = event.message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
    const status =
      typeof message.errorMessage === "string"
        ? { code: SpanStatusCode.ERROR, message: String(message.errorMessage) }
        : undefined;

    endTurnSpan(
      state,
      {
        "pi.turn.index": event.turnIndex,
        "pi.turn.tool_result_count": event.toolResults.length,
        "pi.turn.message.role": typeof message.role === "string" ? String(message.role) : undefined,
        "pi.turn.stop_reason": typeof message.stopReason === "string" ? String(message.stopReason) : undefined,
      },
      status,
    );
  });

  pi.on("agent_end", async (event) => {
    markEvent(state, "agent_end");
    if (!state.activeRequest) return;

    const summary = summarizeAgentMessages(event.messages as unknown[]);
    const status =
      (summary["pi.messages.assistant_errors"] as number) > 0 || (summary["pi.messages.tool_errors"] as number) > 0
        ? { code: SpanStatusCode.ERROR, message: "errors detected in agent output" }
        : undefined;

    endRequestSpan(state, summary, status);
    if (state.provider) {
      await state.provider.forceFlush();
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    syncRuntimeUiState(ctx.hasUI);
    setStatusLabel(ctx, state);
    endRequestSpan(
      state,
      {
        "pi.request.shutdown": true,
      },
      {
        code: SpanStatusCode.ERROR,
        message: "session shutdown",
      },
    );

    if (!state.provider) return;
    await state.provider.forceFlush();
    await state.provider.shutdown();
  });
}
