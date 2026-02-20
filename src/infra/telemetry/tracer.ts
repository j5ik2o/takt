/**
 * OpenTelemetry tracer for TAKT.
 *
 * Initializes the OTEL SDK with OTLP HTTP exporter when configured.
 * Provides helper functions to create spans for piece, movement, and phase execution.
 *
 * Configuration (highest priority first):
 *   1. OTEL_EXPORTER_OTLP_ENDPOINT env var (standard OTEL env var)
 *   2. observability.otlp.endpoint in ~/.takt/config.yaml
 *
 * Spans created:
 *   - takt.piece          (root span, wraps entire piece execution)
 *     - takt.movement     (one per movement execution)
 *       - takt.phase      (one per phase within a movement)
 */

import { trace, context, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';

const TRACER_NAME = 'takt';

let provider: NodeTracerProvider | null = null;
let initialized = false;

export interface OtlpConfig {
  endpoint?: string;
  serviceName?: string;
}

/**
 * Initialize the OTEL SDK.
 * Must be called before any spans are created.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function initTelemetry(config?: OtlpConfig): void {
  if (initialized) return;
  initialized = true;

  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? config?.endpoint;
  if (!endpoint) return;

  const serviceName = process.env['OTEL_SERVICE_NAME'] ?? config?.serviceName ?? 'takt';

  const exporter = new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` });

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    // BatchSpanProcessor is used to buffer and batch spans before export,
    // reducing network overhead and improving throughput in production.
    // Spans are exported asynchronously, so they will be flushed on process exit
    // via shutdownTelemetry().
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  provider.register();
}

/**
 * Shut down the OTEL SDK, flushing any pending spans.
 * Should be called when the process is exiting.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!provider) return;
  try {
    await provider.shutdown();
  } catch {
    // Silently ignore shutdown errors — telemetry must not interrupt main flow.
  }
  provider = null;
  initialized = false;
}

/** Get the TAKT tracer instance */
function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Start a root span for piece execution.
 * Returns the span; call {@link endSpan} when execution completes.
 */
export function startPieceSpan(pieceName: string, task: string): Span {
  const tracer = getTracer();
  const span = tracer.startSpan('takt.piece', undefined, context.active());
  span.setAttribute('takt.piece.name', pieceName);
  span.setAttribute('takt.task', task.slice(0, 200));
  return span;
}

/**
 * Start a child span for a movement execution.
 * Must be called inside the piece span context.
 */
export function startMovementSpan(pieceSpan: Span, movementName: string, iteration: number, movementProvider: string): Span {
  const tracer = getTracer();
  const ctx = trace.setSpan(context.active(), pieceSpan);
  const span = tracer.startSpan('takt.movement', undefined, ctx);
  span.setAttribute('takt.movement.name', movementName);
  span.setAttribute('takt.movement.iteration', iteration);
  span.setAttribute('takt.movement.provider', movementProvider);
  return span;
}

/**
 * Start a child span for a phase execution.
 * Must be called inside the movement span context.
 */
export function startPhaseSpan(movementSpan: Span, movementName: string, phase: number, phaseName: string): Span {
  const tracer = getTracer();
  const ctx = trace.setSpan(context.active(), movementSpan);
  const span = tracer.startSpan('takt.phase', undefined, ctx);
  span.setAttribute('takt.movement.name', movementName);
  span.setAttribute('takt.phase.number', phase);
  span.setAttribute('takt.phase.name', phaseName);
  return span;
}

/**
 * End a span, marking it with an error status if {@link error} is provided.
 */
export function endSpan(span: Span, error?: string): void {
  if (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
}

/** Check if OTEL is configured (SDK initialized with an exporter) */
export function isTelemetryEnabled(): boolean {
  return provider !== null;
}
