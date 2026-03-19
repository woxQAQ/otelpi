# pi-otel

OpenTelemetry tracing extension for `pi-coding-agent`.

This package traces pi agent activity through extension hooks only. The MVP focuses on traces, not metrics or logs, and does not wrap model providers.

## What It Traces

- request lifecycle: `before_agent_start` -> `agent_end`
- turn lifecycle: `turn_start` -> `turn_end`
- tool execution: `tool_execution_start` -> `tool_execution_end`
- provider request metadata from `before_provider_request`
- low-frequency session and model events such as session start, switch, compaction, tree navigation, and model selection

## Privacy Defaults

By default the extension records metadata, counts, durations, and SHA-256 hashes.

It does not emit raw prompt text, provider payloads, tool arguments, or tool results unless you opt in with environment variables.

## Install And Load

### Local path during development

```bash
pi -e /absolute/path/to/pi-otel
```

### Install as a local pi package

```bash
pi install /absolute/path/to/pi-otel -l
```

### Publish later

The repo is a normal npm package with a `pi` manifest, so the same layout can be published to npm or installed from git later.

## Exporter Configuration

The extension supports console, OTLP HTTP, and OTLP gRPC exporters.

### Console

```bash
OTEL_TRACES_EXPORTER=console pi -e /absolute/path/to/pi-otel
```

The console exporter is muted automatically in pi's interactive TUI so spans do not spill into the main UI. Set `PI_OTEL_CONSOLE_IN_UI=1` if you want to see raw console span dumps there.

### OTLP HTTP

```bash
OTEL_TRACES_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf \
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces \
pi -e /absolute/path/to/pi-otel
```

### OTLP gRPC

```bash
OTEL_TRACES_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=grpc \
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4317 \
pi -e /absolute/path/to/pi-otel
```

### Multiple exporters

The extension also accepts `PI_OTEL_EXPORTERS` as a comma-separated override.

```bash
PI_OTEL_EXPORTERS=console,otlp_http \
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces \
pi -e /absolute/path/to/pi-otel
```

Supported tokens:

- `console`
- `otlp`
- `otlp_http`
- `otlp_grpc`
- `http`
- `grpc`
- `none`

`otlp` follows `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` or `OTEL_EXPORTER_OTLP_PROTOCOL`.

## Config Files

The extension can now read its behavior from pi settings files:

- global: `~/.pi/agent/settings.json`
- project: `.pi/settings.json`

It looks for a `piOtel` object. For convenience, it also accepts `"pi-otel"` as an alternate key.

Project config overrides global config. Environment variables override both.

Example:

```json
{
  "piOtel": {
    "exporters": ["console", "otlp_http"],
    "serviceName": "pi-dev",
    "serviceVersion": "0.1.0-local",
    "httpEndpoint": "http://127.0.0.1:4318/v1/traces",
    "consoleInUi": false,
    "summaryLength": 512,
    "capture": {
      "prompts": false,
      "providerPayloads": false,
      "toolArgs": true,
      "toolResults": false
    }
  }
}
```

Supported config keys under `piOtel`:

- `enabled`: boolean
- `exporters`: string or string[]
- `serviceName`: string
- `serviceVersion`: string
- `httpEndpoint`: string
- `grpcEndpoint`: string
- `consoleInUi`: boolean
- `summaryLength`: number
- `capture.prompts`: boolean
- `capture.providerPayloads`: boolean
- `capture.toolArgs`: boolean
- `capture.toolResults`: boolean

## Extension-Specific Environment Variables

- `PI_OTEL_ENABLED=0|1`: disable or enable the extension regardless of config file
- `PI_OTEL_SERVICE_NAME`: override the emitted `service.name` resource attribute
- `PI_OTEL_SERVICE_VERSION`: override the emitted `service.version` resource attribute
- `PI_OTEL_EXPORTERS`: comma-separated exporter override
- `PI_OTEL_HTTP_ENDPOINT`: optional explicit OTLP HTTP endpoint override
- `PI_OTEL_GRPC_ENDPOINT`: optional explicit OTLP gRPC endpoint override
- `PI_OTEL_CONSOLE_IN_UI=0|1`: allow or mute console exporter output inside the interactive TUI
- `PI_OTEL_SUMMARY_LENGTH`: max stored raw preview length when raw capture is enabled
- `PI_OTEL_CAPTURE_PROMPTS=1`: include raw prompt text
- `PI_OTEL_CAPTURE_PROVIDER_PAYLOADS=1`: include raw provider payloads
- `PI_OTEL_CAPTURE_TOOL_ARGS=1`: include raw tool arguments
- `PI_OTEL_CAPTURE_TOOL_RESULTS=1`: include raw tool results

## Diagnostics Commands

After loading the extension, these commands are available:

- `/otel-status`: print current tracer configuration and runtime state
- `/otel-flush`: force-flush pending spans

## Expected Span Shape

- `pi.request`
- `pi.turn`
- `pi.tool`
- standalone event spans such as `pi.session_start`, `pi.session_switch`, `pi.session_compact`, and `pi.model_select`

Provider request payload information is attached as events on the active request or turn span.

## Manual Verification

1. Start with the console exporter and run a normal prompt.
2. Run a prompt that triggers one or more tool calls.
3. Switch models and run another prompt.
4. Trigger a failed or blocked tool path.
5. Run `/otel-status` and `/otel-flush`.
6. Repeat with an OTLP collector over HTTP and gRPC.

Check that spans follow this hierarchy:

- `pi.request`
- child `pi.turn`
- child `pi.tool`

Check that default mode emits counts, durations, hashes, and IDs, while raw bodies only appear after enabling the relevant `PI_OTEL_CAPTURE_*` flags.
