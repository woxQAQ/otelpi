# pi-otel

OpenTelemetry tracing extension for `pi-coding-agent`.

`pi-otel` emits spans from pi extension hooks. It focuses on tracing request, turn, tool, and session activity without wrapping model providers or collecting metrics/logs.

## Highlights

- traces the main pi lifecycle: request, turn, and tool execution
- records session and model events such as session start, switch, fork, tree navigation, compaction, and model selection
- attaches provider request metadata to the active request or turn span
- keeps raw content off by default and stores hashes, counts, and durations instead
- supports console, OTLP HTTP, and OTLP gRPC exporters
- reads config from pi settings files and environment variables

## Privacy Defaults

By default, the extension emits metadata only:

- counts
- durations
- IDs and basic labels
- SHA-256 hashes of prompts and structured payloads

It does not emit raw prompt text, provider payloads, tool arguments, or tool results unless you opt in.

## Span Model

Core spans:

- `pi.request`
- `pi.turn`
- `pi.tool`

Standalone event spans:

- `pi.session_start`
- `pi.session_switch`
- `pi.session_fork`
- `pi.session_tree`
- `pi.session_compact`
- `pi.model_select`

Additional provider request details are attached as `provider.request` events on the active request or turn span.

Typical hierarchy:

- `pi.request`
- child `pi.turn`
- child `pi.tool`

## Quick Start

### Load from a local path

```bash
pi -e /absolute/path/to/pi-otel
```

### Install as a local pi package

```bash
pi install /absolute/path/to/pi-otel -l
```

This repository is already structured as a normal npm package with a `pi` manifest, so it can also be published to npm or installed from git later.

## Exporters

If you do not configure anything, `pi-otel` defaults to the `console` exporter.

In pi's interactive TUI, console span output is muted automatically so traces do not spill into the UI. Set `PI_OTEL_CONSOLE_IN_UI=1` to allow console exporter output inside the TUI.

### Console

```bash
OTEL_TRACES_EXPORTER=console pi -e /absolute/path/to/pi-otel
```

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

`PI_OTEL_EXPORTERS` is an extension-specific override that accepts a comma-separated list.

```bash
PI_OTEL_EXPORTERS=console,otlp_http \
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces \
pi -e /absolute/path/to/pi-otel
```

Supported exporter tokens:

- `console`
- `otlp`
- `otlp_http`
- `otlp_grpc`
- `http`
- `grpc`
- `none`

Notes:

- `otlp` resolves to HTTP or gRPC using `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` or `OTEL_EXPORTER_OTLP_PROTOCOL`
- `none` disables exporting without uninstalling the extension
- `PI_OTEL_EXPORTERS` takes precedence over `OTEL_TRACES_EXPORTER`

## Configuration Sources

Configuration is resolved in this order:

1. environment variables
2. project settings in `.pi/settings.json`
3. global settings in `~/.pi/agent/settings.json`

The extension looks for a `piOtel` object. It also accepts `"pi-otel"` as an alternate key.

Example project config:

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

Supported config keys under `piOtel` or `pi-otel`:

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

## Environment Variables

Extension-specific overrides:

- `PI_OTEL_ENABLED=0|1`: force-disable or force-enable the extension
- `PI_OTEL_SERVICE_NAME`: override the emitted `service.name`
- `PI_OTEL_SERVICE_VERSION`: override the emitted `service.version`
- `PI_OTEL_EXPORTERS`: comma-separated exporter override
- `PI_OTEL_HTTP_ENDPOINT`: explicit OTLP HTTP endpoint
- `PI_OTEL_GRPC_ENDPOINT`: explicit OTLP gRPC endpoint
- `PI_OTEL_CONSOLE_IN_UI=0|1`: allow or mute console output in the TUI
- `PI_OTEL_SUMMARY_LENGTH`: max raw preview length when raw capture is enabled
- `PI_OTEL_CAPTURE_PROMPTS=1`: include raw prompt text
- `PI_OTEL_CAPTURE_PROVIDER_PAYLOADS=1`: include raw provider payloads
- `PI_OTEL_CAPTURE_TOOL_ARGS=1`: include raw tool arguments
- `PI_OTEL_CAPTURE_TOOL_RESULTS=1`: include raw tool results

Related OpenTelemetry variables:

- `OTEL_TRACES_EXPORTER`
- `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`
- `OTEL_EXPORTER_OTLP_PROTOCOL`
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- `OTEL_SERVICE_NAME`

## Runtime Commands

After loading the extension, these commands are available:

- `/otel-status`: print resolved config, runtime state, warnings, and recent event counters
- `/otel-flush`: force-flush pending spans

## Verification

A quick manual check:

1. Start with the console exporter and run a normal prompt.
2. Run a prompt that triggers one or more tool calls.
3. Switch models and run another prompt.
4. Trigger a failed or blocked tool path.
5. Run `/otel-status` and `/otel-flush`.
6. Repeat with an OTLP collector over HTTP and gRPC.

What to verify:

- spans follow the request -> turn -> tool hierarchy
- session and model events appear as standalone spans
- provider request metadata shows up as span events
- default mode emits hashes, counts, durations, and IDs only
- raw bodies appear only after enabling the matching `PI_OTEL_CAPTURE_*` flags

## Development Notes

This package currently has no build step and no static checks configured:

```bash
npm run build
npm run check
```
