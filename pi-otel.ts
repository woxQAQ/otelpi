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
import type { Attributes } from "./lib/pi-otel-types.js";

type PendingSessionKey = "pendingSessionSwitch" | "pendingSessionFork" | "pendingSessionCompact" | "pendingSessionTree";

const pendingSessionMeta: Record<PendingSessionKey, { durationKey: string; orphanMessage: string }> = {
  pendingSessionSwitch: {
    durationKey: "pi.session.switch_duration_ms",
    orphanMessage: "superseded by a newer session switch",
  },
  pendingSessionFork: {
    durationKey: "pi.session.fork_duration_ms",
    orphanMessage: "superseded by a newer session fork",
  },
  pendingSessionCompact: {
    durationKey: "pi.session.compact_duration_ms",
    orphanMessage: "superseded by a newer compaction",
  },
  pendingSessionTree: {
    durationKey: "pi.session.tree_duration_ms",
    orphanMessage: "superseded by newer tree navigation",
  },
};

function messageRole(message: unknown): string {
  return typeof (message as { role?: unknown })?.role === "string" ? String((message as { role?: unknown }).role) : "unknown";
}

function messageStatus(message: unknown): { code: SpanStatusCode; message?: string } | undefined {
  if (typeof (message as { errorMessage?: unknown })?.errorMessage === "string") {
    return {
      code: SpanStatusCode.ERROR,
      message: String((message as { errorMessage?: unknown }).errorMessage),
    };
  }

  if ((message as { isError?: unknown })?.isError === true) {
    return {
      code: SpanStatusCode.ERROR,
      message: "message marked as error",
    };
  }

  return undefined;
}

export default function (pi: ExtensionAPI) {
  const state = createRuntime();
  const syncRuntimeUiState = (hasUI: boolean) => syncUiState(state, hasUI);

  const recordScopedSpan = (name: string, attrs: Attributes, parent = state.activeTurn?.span ?? state.activeRequest?.span) => {
    if (!state.tracer) return;
    const span = state.tracer.startSpan(name, {}, getParentSpanContext(parent));
    setSpanAttributes(span, attrs);
    span.end();
  };

  const endActiveMessageSpan = (attrs: Attributes = {}, status?: { code: number; message?: string }) => {
    const activeMessage = state.activeMessage;
    if (!activeMessage) return false;

    setSpanAttributes(activeMessage.span, {
      "pi.message.duration_ms": Date.now() - activeMessage.startedAt,
      "pi.message.update_count": activeMessage.updateCount,
      "pi.message.first_update_ms": activeMessage.firstUpdateAt
        ? activeMessage.firstUpdateAt - activeMessage.startedAt
        : undefined,
      "pi.message.first_update_type": activeMessage.firstUpdateType,
      ...attrs,
    });

    if (status) {
      activeMessage.span.setStatus(status);
    }

    activeMessage.span.end();
    state.activeMessage = undefined;
    return true;
  };

  const endPendingSessionSpan = (
    key: PendingSessionKey,
    attrs: Attributes = {},
    status?: { code: number; message?: string },
  ) => {
    const pending = state[key];
    if (!pending) return false;

    setSpanAttributes(pending.span, {
      [pendingSessionMeta[key].durationKey]: Date.now() - pending.startedAt,
      ...attrs,
    });

    if (status) {
      pending.span.setStatus(status);
    }

    pending.span.end();
    state[key] = undefined;
    return true;
  };

  const startPendingSessionSpan = (key: PendingSessionKey, name: string, attrs: Attributes) => {
    if (!state.tracer) return;

    endPendingSessionSpan(
      key,
      {
        "pi.session.orphaned": true,
      },
      {
        code: SpanStatusCode.ERROR,
        message: pendingSessionMeta[key].orphanMessage,
      },
    );

    const span = state.tracer.startSpan(name);
    setSpanAttributes(span, attrs);
    state[key] = {
      span,
      startedAt: Date.now(),
    };
  };

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

  pi.on("input", async (event, ctx) => {
    markEvent(state, "input");
    syncRuntimeUiState(ctx.hasUI);
    recordStandaloneSpan(state, "pi.input", {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.input.source": event.source,
      "pi.input.image_count": event.images?.length ?? 0,
      ...summarizeText("pi.input.text", event.text, false, state.config.summaryLength),
    });
  });

  pi.on("user_bash", async (event, ctx) => {
    markEvent(state, "user_bash");
    syncRuntimeUiState(ctx.hasUI);
    recordStandaloneSpan(state, "pi.user_bash", {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.user_bash.cwd": event.cwd,
      "pi.user_bash.exclude_from_context": event.excludeFromContext,
      ...summarizeText("pi.user_bash.command", event.command, false, state.config.summaryLength),
    });
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

  pi.on("session_before_switch", async (event, ctx) => {
    markEvent(state, "session_before_switch");
    syncRuntimeUiState(ctx.hasUI);
    startPendingSessionSpan("pendingSessionSwitch", "pi.session_switch", {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.session.reason": event.reason,
      "pi.session.target_file": event.targetSessionFile,
    });
  });

  pi.on("session_switch", async (event, ctx) => {
    markEvent(state, "session_switch");
    syncRuntimeUiState(ctx.hasUI);
    setStatusLabel(ctx, state);
    const attrs = {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.session.reason": event.reason,
      "pi.session.previous_file": event.previousSessionFile,
    };

    if (endPendingSessionSpan("pendingSessionSwitch", attrs)) {
      return;
    }

    recordStandaloneSpan(state, "pi.session_switch", attrs);
  });

  pi.on("session_before_fork", async (event, ctx) => {
    markEvent(state, "session_before_fork");
    syncRuntimeUiState(ctx.hasUI);
    startPendingSessionSpan("pendingSessionFork", "pi.session_fork", {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.session.entry_id": event.entryId,
    });
  });

  pi.on("session_fork", async (event, ctx) => {
    markEvent(state, "session_fork");
    syncRuntimeUiState(ctx.hasUI);
    const attrs = {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.session.previous_file": event.previousSessionFile,
    };

    if (endPendingSessionSpan("pendingSessionFork", attrs)) {
      return;
    }

    recordStandaloneSpan(state, "pi.session_fork", attrs);
  });

  pi.on("session_before_tree", async (event, ctx) => {
    markEvent(state, "session_before_tree");
    syncRuntimeUiState(ctx.hasUI);
    startPendingSessionSpan("pendingSessionTree", "pi.session_tree", {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.session.target_id": event.preparation.targetId,
      "pi.session.old_leaf_id": event.preparation.oldLeafId ?? undefined,
      "pi.session.common_ancestor_id": event.preparation.commonAncestorId ?? undefined,
      "pi.session.entries_to_summarize": event.preparation.entriesToSummarize.length,
      "pi.session.user_wants_summary": event.preparation.userWantsSummary,
      "pi.session.replace_instructions": Boolean(event.preparation.replaceInstructions),
      "pi.session.has_custom_instructions": Boolean(event.preparation.customInstructions),
      "pi.session.label": event.preparation.label,
    });
  });

  pi.on("session_tree", async (event, ctx) => {
    markEvent(state, "session_tree");
    syncRuntimeUiState(ctx.hasUI);
    const attrs = {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.session.new_leaf_id": event.newLeafId ?? undefined,
      "pi.session.old_leaf_id": event.oldLeafId ?? undefined,
      "pi.session.has_summary": Boolean(event.summaryEntry),
      "pi.session.from_extension": Boolean(event.fromExtension),
    };

    if (endPendingSessionSpan("pendingSessionTree", attrs)) {
      return;
    }

    recordStandaloneSpan(state, "pi.session_tree", attrs);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    markEvent(state, "session_before_compact");
    syncRuntimeUiState(ctx.hasUI);
    startPendingSessionSpan("pendingSessionCompact", "pi.session_compact", {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.compaction.first_kept_entry_id": event.preparation.firstKeptEntryId,
      "pi.compaction.tokens_before": event.preparation.tokensBefore,
      "pi.compaction.messages_to_summarize": event.preparation.messagesToSummarize.length,
      "pi.compaction.turn_prefix_messages": event.preparation.turnPrefixMessages.length,
      "pi.compaction.is_split_turn": event.preparation.isSplitTurn,
      "pi.compaction.has_previous_summary": Boolean(event.preparation.previousSummary),
      "pi.compaction.branch_entries": event.branchEntries.length,
      "pi.compaction.has_custom_instructions": Boolean(event.customInstructions),
    });
  });

  pi.on("session_compact", async (event, ctx) => {
    markEvent(state, "session_compact");
    syncRuntimeUiState(ctx.hasUI);
    const attrs = {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.compaction.from_extension": event.fromExtension,
      "pi.compaction.tokens_before": event.compactionEntry.tokensBefore,
      "pi.compaction.first_kept_entry_id": event.compactionEntry.firstKeptEntryId,
    };

    if (endPendingSessionSpan("pendingSessionCompact", attrs)) {
      return;
    }

    recordStandaloneSpan(state, "pi.session_compact", attrs);
  });

  pi.on("model_select", async (event, ctx) => {
    markEvent(state, "model_select");
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

    endActiveMessageSpan(
      {
        "pi.message.orphaned": true,
      },
      {
        code: SpanStatusCode.ERROR,
        message: "replaced by a newer request",
      },
    );

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
      ...summarizeText("pi.system_prompt", event.systemPrompt, false, state.config.summaryLength),
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

  pi.on("context", async (event, ctx) => {
    markEvent(state, "context");
    syncRuntimeUiState(ctx.hasUI);
    recordScopedSpan("pi.context", {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      ...summarizeAgentMessages(event.messages as unknown[]),
    });
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

  pi.on("before_provider_request", async (event, ctx) => {
    markEvent(state, "before_provider_request");
    syncRuntimeUiState(ctx.hasUI);
    const target = state.activeTurn?.span ?? state.activeRequest?.span;
    if (!target) return;

    if (state.activeRequest) state.activeRequest.providerRequestCount += 1;
    if (state.activeTurn) state.activeTurn.providerRequestCount += 1;

    const attrs = {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.provider.request.index": state.activeRequest?.providerRequestCount,
      ...summarizeValue(
        "pi.provider.request",
        event.payload,
        state.config.capture.providerPayloads,
        state.config.summaryLength,
      ),
    };

    addSpanEvent(target, "provider.request", attrs);
    recordScopedSpan("pi.provider_request", attrs, target);
  });

  pi.on("message_start", async (event, ctx) => {
    markEvent(state, "message_start");
    syncRuntimeUiState(ctx.hasUI);
    if (!state.tracer) return;

    endActiveMessageSpan(
      {
        "pi.message.orphaned": true,
      },
      {
        code: SpanStatusCode.ERROR,
        message: "replaced by a newer message",
      },
    );

    const role = messageRole(event.message);
    const messageSpan = state.tracer.startSpan(
      "pi.message",
      {},
      getParentSpanContext(state.activeTurn?.span ?? state.activeRequest?.span),
    );

    setSpanAttributes(messageSpan, {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.message.role": role,
      "pi.message.timestamp": typeof (event.message as { timestamp?: unknown })?.timestamp === "number"
        ? (event.message as { timestamp: number }).timestamp
        : undefined,
      ...summarizeValue("pi.message.initial", event.message, false, state.config.summaryLength),
    });

    state.activeMessage = {
      span: messageSpan,
      role,
      startedAt: Date.now(),
      updateCount: 0,
    };
  });

  pi.on("message_update", async (event) => {
    markEvent(state, "message_update");

    if (state.activeMessage) {
      state.activeMessage.updateCount += 1;
      if (state.activeMessage.firstUpdateAt === undefined) {
        state.activeMessage.firstUpdateAt = Date.now();
        state.activeMessage.firstUpdateType = event.assistantMessageEvent.type;
        addSpanEvent(state.activeMessage.span, "message.first_update", {
          "pi.message.update_event": event.assistantMessageEvent.type,
        });
      }
    }

    if (!state.activeTurn || state.activeTurn.firstOutputAt !== undefined) return;
    const eventType = event.assistantMessageEvent.type;
    if (eventType.endsWith("_delta") || eventType.endsWith("_start") || eventType.endsWith("_end")) {
      state.activeTurn.firstOutputAt = Date.now();
      addSpanEvent(state.activeTurn.span, "turn.first_output", {
        "pi.turn.first_output_event": eventType,
      });
    }
  });

  pi.on("message_end", async (event) => {
    markEvent(state, "message_end");
    const role = messageRole(event.message);
    endActiveMessageSpan(
      {
        "pi.message.role": role,
        "pi.message.stop_reason": typeof (event.message as { stopReason?: unknown })?.stopReason === "string"
          ? String((event.message as { stopReason?: unknown }).stopReason)
          : undefined,
        "pi.message.provider": typeof (event.message as { provider?: unknown })?.provider === "string"
          ? String((event.message as { provider?: unknown }).provider)
          : undefined,
        "pi.message.model": typeof (event.message as { model?: unknown })?.model === "string"
          ? String((event.message as { model?: unknown }).model)
          : undefined,
        "pi.message.is_error": (event.message as { isError?: unknown })?.isError === true,
        ...summarizeValue("pi.message.final", event.message, false, state.config.summaryLength),
      },
      messageStatus(event.message),
    );
  });

  pi.on("tool_call", async (event, ctx) => {
    markEvent(state, "tool_call");
    syncRuntimeUiState(ctx.hasUI);
    recordScopedSpan("pi.tool_call", {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.tool.name": event.toolName,
      "pi.tool.call_id": event.toolCallId,
      ...summarizeValue("pi.tool.input", event.input, state.config.capture.toolArgs, state.config.summaryLength),
    });
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
    markEvent(state, "tool_execution_update");
    const toolState = state.toolSpans.get(event.toolCallId);
    if (!toolState) return;
    toolState.updateCount += 1;

    if (toolState.updateCount === 1) {
      addSpanEvent(toolState.span, "tool.update", {
        "pi.tool.partial.kind": Array.isArray(event.partialResult) ? "array" : typeof event.partialResult,
      });
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    markEvent(state, "tool_result");
    syncRuntimeUiState(ctx.hasUI);
    const toolSpan = state.toolSpans.get(event.toolCallId)?.span;
    const attrs = {
      ...currentModelAttributes(ctx, pi.getThinkingLevel()),
      "pi.tool.name": event.toolName,
      "pi.tool.call_id": event.toolCallId,
      "pi.tool.is_error": event.isError,
      ...summarizeValue("pi.tool.result_input", event.input, state.config.capture.toolArgs, state.config.summaryLength),
      ...summarizeValue("pi.tool.result_content", event.content, false, state.config.summaryLength),
      ...summarizeValue("pi.tool.result_details", event.details, state.config.capture.toolResults, state.config.summaryLength),
    };

    if (toolSpan) {
      addSpanEvent(toolSpan, "tool.result", attrs);
    }

    recordScopedSpan("pi.tool_result", attrs, toolSpan ?? state.activeTurn?.span ?? state.activeRequest?.span);
  });

  pi.on("tool_execution_end", async (event) => {
    markEvent(state, "tool_execution_end");
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

    const role = messageRole(event.message);
    endActiveMessageSpan(
      {
        "pi.message.role": role,
        "pi.message.stop_reason": typeof (event.message as { stopReason?: unknown })?.stopReason === "string"
          ? String((event.message as { stopReason?: unknown }).stopReason)
          : undefined,
        "pi.message.orphaned": true,
        ...summarizeValue("pi.message.final", event.message, false, state.config.summaryLength),
      },
      messageStatus(event.message) ?? {
        code: SpanStatusCode.ERROR,
        message: "turn ended before message_end was observed",
      },
    );

    endTurnSpan(
      state,
      {
        "pi.turn.index": event.turnIndex,
        "pi.turn.tool_result_count": event.toolResults.length,
        "pi.turn.message.role": role,
        "pi.turn.stop_reason": typeof (event.message as { stopReason?: unknown })?.stopReason === "string"
          ? String((event.message as { stopReason?: unknown }).stopReason)
          : undefined,
      },
      messageStatus(event.message),
    );
  });

  pi.on("agent_end", async (event) => {
    markEvent(state, "agent_end");
    if (!state.activeRequest) return;

    endActiveMessageSpan(
      {
        "pi.message.orphaned": true,
      },
      {
        code: SpanStatusCode.ERROR,
        message: "agent ended before message finished",
      },
    );

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
    markEvent(state, "session_shutdown");
    syncRuntimeUiState(ctx.hasUI);
    setStatusLabel(ctx, state);

    endActiveMessageSpan(
      {
        "pi.message.shutdown": true,
      },
      {
        code: SpanStatusCode.ERROR,
        message: "session shutdown",
      },
    );

    endPendingSessionSpan(
      "pendingSessionSwitch",
      {
        "pi.session.shutdown": true,
      },
      {
        code: SpanStatusCode.ERROR,
        message: "session shutdown",
      },
    );
    endPendingSessionSpan(
      "pendingSessionFork",
      {
        "pi.session.shutdown": true,
      },
      {
        code: SpanStatusCode.ERROR,
        message: "session shutdown",
      },
    );
    endPendingSessionSpan(
      "pendingSessionCompact",
      {
        "pi.session.shutdown": true,
      },
      {
        code: SpanStatusCode.ERROR,
        message: "session shutdown",
      },
    );
    endPendingSessionSpan(
      "pendingSessionTree",
      {
        "pi.session.shutdown": true,
      },
      {
        code: SpanStatusCode.ERROR,
        message: "session shutdown",
      },
    );

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
