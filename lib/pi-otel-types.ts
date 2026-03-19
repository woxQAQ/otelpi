import type { Span, Tracer } from "@opentelemetry/api";
import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

export const EXTENSION_NAME = "pi-otel";
export const EXTENSION_VERSION = "0.1.0";
export const STATUS_KEY = "pi-otel";
export const DEFAULT_SERVICE_NAME = "pi-otel";
export const DEFAULT_SUMMARY_LENGTH = 256;
export const MAX_STRING_ATTRIBUTE_LENGTH = 1024;
export const MAX_KEY_COUNT = 12;
export const PROJECT_CONFIG_DIR = ".pi";
export const SETTINGS_FILE_NAME = "settings.json";

export type ExporterName = "console" | "otlp_http" | "otlp_grpc";

export type PrimitiveAttribute = string | number | boolean | string[];

export type Attributes = Record<string, PrimitiveAttribute | undefined>;

export interface CaptureConfig {
  prompts: boolean;
  providerPayloads: boolean;
  toolArgs: boolean;
  toolResults: boolean;
}

export interface FileConfig {
  enabled?: boolean;
  exporters?: string[] | string;
  serviceName?: string;
  serviceVersion?: string;
  httpEndpoint?: string;
  grpcEndpoint?: string;
  consoleInUi?: boolean;
  summaryLength?: number;
  capture?: Partial<CaptureConfig>;
}

export interface LoadedSettingsConfig {
  config: FileConfig;
  warnings: string[];
  sources: string[];
}

export interface ResolvedConfig {
  enabled: boolean;
  exporters: ExporterName[];
  exporterLabel: string;
  serviceName: string;
  serviceVersion: string;
  httpEndpoint?: string;
  grpcEndpoint?: string;
  consoleInUi: boolean;
  capture: CaptureConfig;
  summaryLength: number;
  warnings: string[];
  configSources: string[];
  error?: string;
}

export interface TimedSpanState {
  span: Span;
  startedAt: number;
}

export interface ToolSpanState extends TimedSpanState {
  toolName: string;
  updateCount: number;
}

export interface MessageSpanState extends TimedSpanState {
  role: string;
  updateCount: number;
  firstUpdateAt?: number;
  firstUpdateType?: string;
}

export interface TurnSpanState extends TimedSpanState {
  index: number;
  providerRequestCount: number;
  firstOutputAt?: number;
}

export interface RequestSpanState extends TimedSpanState {
  sequence: number;
  providerRequestCount: number;
}

export interface RuntimeState {
  config: ResolvedConfig;
  provider?: BasicTracerProvider;
  tracer?: Tracer;
  error?: string;
  requestSequence: number;
  uiDetected: boolean;
  consoleExportEnabled: boolean;
  eventCounts: Record<string, number>;
  activeRequest?: RequestSpanState;
  activeTurn?: TurnSpanState;
  activeMessage?: MessageSpanState;
  pendingSessionSwitch?: TimedSpanState;
  pendingSessionFork?: TimedSpanState;
  pendingSessionCompact?: TimedSpanState;
  pendingSessionTree?: TimedSpanState;
  toolSpans: Map<string, ToolSpanState>;
}
