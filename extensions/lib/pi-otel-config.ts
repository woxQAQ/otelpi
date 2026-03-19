import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_SERVICE_NAME,
  DEFAULT_SUMMARY_LENGTH,
  EXTENSION_NAME,
  EXTENSION_VERSION,
  type ExporterName,
  type FileConfig,
  type LoadedSettingsConfig,
  PROJECT_CONFIG_DIR,
  type ResolvedConfig,
  SETTINGS_FILE_NAME,
} from "./pi-otel-types.js";

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readEnvList(names: string[]): string | undefined {
  for (const name of names) {
    const value = readEnv(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function parseBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const parsed = parseBooleanLike(readEnv(name));
  return parsed ?? fallback;
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function readNumberEnv(name: string, fallback: number): number {
  return parsePositiveInteger(readEnv(name)) ?? fallback;
}

function deepMergeConfig(base: FileConfig, override: FileConfig): FileConfig {
  return {
    ...base,
    ...override,
    capture: {
      ...(base.capture ?? {}),
      ...(override.capture ?? {}),
    },
  };
}

function pickExtensionConfig(raw: unknown): FileConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const candidate = record.piOtel ?? record[EXTENSION_NAME];
  if (!candidate || typeof candidate !== "object") return undefined;
  return candidate as FileConfig;
}

function loadJsonConfig(path: string, warnings: string[]): FileConfig {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return pickExtensionConfig(raw) ?? {};
  } catch (error) {
    warnings.push(`Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function loadSettingsConfig(): LoadedSettingsConfig {
  const warnings: string[] = [];
  const globalPath = join(getAgentDir(), SETTINGS_FILE_NAME);
  const projectPath = join(process.cwd(), PROJECT_CONFIG_DIR, SETTINGS_FILE_NAME);

  const globalConfig = loadJsonConfig(globalPath, warnings);
  const projectConfig = loadJsonConfig(projectPath, warnings);
  const sources: string[] = [];

  if (Object.keys(globalConfig).length > 0) sources.push(globalPath);
  if (Object.keys(projectConfig).length > 0) sources.push(projectPath);

  return {
    config: deepMergeConfig(globalConfig, projectConfig),
    warnings,
    sources,
  };
}

function normalizeExporterNames(raw: string[] | string | undefined, warnings: string[]): ExporterName[] | undefined {
  if (raw === undefined) return undefined;

  const tokens = (Array.isArray(raw) ? raw : String(raw).split(","))
    .map((token) => String(token).trim().toLowerCase())
    .filter(Boolean);

  if (tokens.length === 0) return [];
  if (tokens.includes("none")) return [];

  const names = new Set<ExporterName>();
  for (const token of tokens) {
    switch (token) {
      case "console":
        names.add("console");
        break;
      case "otlp_http":
      case "http":
        names.add("otlp_http");
        break;
      case "otlp_grpc":
      case "grpc":
        names.add("otlp_grpc");
        break;
      case "otlp": {
        const protocol = (readEnvList(["OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "OTEL_EXPORTER_OTLP_PROTOCOL"]) ?? "http/protobuf").toLowerCase();
        names.add(protocol === "grpc" ? "otlp_grpc" : "otlp_http");
        break;
      }
      default:
        warnings.push(`Unknown exporter token: ${token}`);
        break;
    }
  }
  return [...names];
}

function resolveExporterNames(fileConfig: FileConfig, warnings: string[]): ExporterName[] {
  const envRaw = readEnvList(["PI_OTEL_EXPORTERS", "OTEL_TRACES_EXPORTER"]);
  const envNames = normalizeExporterNames(envRaw, warnings);
  if (envNames !== undefined) return envNames;

  const fileNames = normalizeExporterNames(fileConfig.exporters, warnings);
  if (fileNames !== undefined) return fileNames;

  return ["console"];
}

export function buildConfig(): ResolvedConfig {
  const loadedSettings = loadSettingsConfig();
  const warnings = [...loadedSettings.warnings];
  const { config: fileConfig } = loadedSettings;
  const exporters = resolveExporterNames(fileConfig, warnings);
  const exporterSource = readEnvList(["PI_OTEL_EXPORTERS", "OTEL_TRACES_EXPORTER"]);
  const enabledFromConfig = parseBooleanLike(readEnv("PI_OTEL_ENABLED")) ?? fileConfig.enabled;
  const serviceName = readEnv("PI_OTEL_SERVICE_NAME") ?? readEnv("OTEL_SERVICE_NAME") ?? fileConfig.serviceName ?? DEFAULT_SERVICE_NAME;
  const serviceVersion = readEnv("PI_OTEL_SERVICE_VERSION") ?? fileConfig.serviceVersion ?? EXTENSION_VERSION;
  const summaryLength = readNumberEnv("PI_OTEL_SUMMARY_LENGTH", parsePositiveInteger(fileConfig.summaryLength) ?? DEFAULT_SUMMARY_LENGTH);
  const httpEndpoint = readEnv("PI_OTEL_HTTP_ENDPOINT") ?? fileConfig.httpEndpoint;
  const grpcEndpoint = readEnv("PI_OTEL_GRPC_ENDPOINT") ?? fileConfig.grpcEndpoint;
  const consoleInUi = readBooleanEnv("PI_OTEL_CONSOLE_IN_UI", fileConfig.consoleInUi ?? false);
  const enabled = enabledFromConfig ?? exporters.length > 0;

  if (exporters.includes("otlp_grpc") && grpcEndpoint?.includes("/v1/traces")) {
    warnings.push("gRPC exporter endpoints should usually omit /v1/traces");
  }

  const error = !enabled
    ? undefined
    : exporters.length === 0 && exporterSource !== "none"
      ? "No valid exporters were resolved from environment or settings configuration"
      : undefined;

  return {
    enabled,
    exporters,
    exporterLabel: exporters.length > 0 ? exporters.join(",") : "disabled",
    serviceName,
    serviceVersion,
    httpEndpoint,
    grpcEndpoint,
    consoleInUi,
    summaryLength,
    warnings,
    configSources: loadedSettings.sources,
    error,
    capture: {
      prompts: readBooleanEnv("PI_OTEL_CAPTURE_PROMPTS", fileConfig.capture?.prompts ?? false),
      providerPayloads: readBooleanEnv("PI_OTEL_CAPTURE_PROVIDER_PAYLOADS", fileConfig.capture?.providerPayloads ?? false),
      toolArgs: readBooleanEnv("PI_OTEL_CAPTURE_TOOL_ARGS", fileConfig.capture?.toolArgs ?? false),
      toolResults: readBooleanEnv("PI_OTEL_CAPTURE_TOOL_RESULTS", fileConfig.capture?.toolResults ?? false),
    },
  };
}
