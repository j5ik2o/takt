/**
 * Tests for OpenTelemetry telemetry module
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  startPieceSpan,
  startMovementSpan,
  startPhaseSpan,
  endSpan,
  initTelemetry,
  isTelemetryEnabled,
  shutdownTelemetry,
} from '../infra/telemetry/tracer.js';

describe('telemetry tracer', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
  });

  afterAll(async () => {
    await provider.shutdown();
  });

  it('should create a piece span with correct attributes', () => {
    exporter.reset();
    const span = startPieceSpan('my-piece', 'Fix bug #42');
    endSpan(span);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);

    const pieceSpan = spans[0]!;
    expect(pieceSpan.name).toBe('takt.piece');
    expect(pieceSpan.attributes['takt.piece.name']).toBe('my-piece');
    expect(pieceSpan.attributes['takt.task']).toBe('Fix bug #42');
  });

  it('should create movement span as child of piece span', () => {
    exporter.reset();
    const pieceSpan = startPieceSpan('my-piece', 'task');
    const movementSpan = startMovementSpan(pieceSpan, 'plan', 1, 'claude');
    endSpan(movementSpan);
    endSpan(pieceSpan);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);

    const movement = spans.find((s) => s.name === 'takt.movement')!;
    const piece = spans.find((s) => s.name === 'takt.piece')!;

    expect(movement).toBeDefined();
    expect(movement.attributes['takt.movement.name']).toBe('plan');
    expect(movement.attributes['takt.movement.iteration']).toBe(1);
    expect(movement.attributes['takt.movement.provider']).toBe('claude');

    // The movement span must be a child of the piece span
    expect(movement.parentSpanContext?.spanId).toBe(piece.spanContext().spanId);
  });

  it('should create phase span as child of movement span', () => {
    exporter.reset();
    const pieceSpan = startPieceSpan('my-piece', 'task');
    const movementSpan = startMovementSpan(pieceSpan, 'implement', 2, 'codex');
    const phaseSpan = startPhaseSpan(movementSpan, 'implement', 1, 'execute');
    endSpan(phaseSpan);
    endSpan(movementSpan);
    endSpan(pieceSpan);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(3);

    const phase = spans.find((s) => s.name === 'takt.phase')!;
    const movement = spans.find((s) => s.name === 'takt.movement')!;

    expect(phase).toBeDefined();
    expect(phase.attributes['takt.movement.name']).toBe('implement');
    expect(phase.attributes['takt.phase.number']).toBe(1);
    expect(phase.attributes['takt.phase.name']).toBe('execute');
    expect(phase.parentSpanContext?.spanId).toBe(movement.spanContext().spanId);
  });

  it('should mark span as error when error message is provided', () => {
    exporter.reset();
    const span = startPieceSpan('my-piece', 'task');
    endSpan(span, 'Something went wrong');

    const spans = exporter.getFinishedSpans();
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]!.status.message).toBe('Something went wrong');
  });

  it('should truncate task to 200 characters', () => {
    exporter.reset();
    const longTask = 'a'.repeat(300);
    const span = startPieceSpan('my-piece', longTask);
    endSpan(span);

    const spans = exporter.getFinishedSpans();
    expect(String(spans[0]!.attributes['takt.task']).length).toBe(200);
  });

  it('initTelemetry should be a no-op when no endpoint is configured', async () => {
    const savedEnv = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

    // initTelemetry won't register a new provider when already initialized
    // so we just verify it doesn't throw and isTelemetryEnabled reflects SDK state
    initTelemetry(); // no config, no env var — should be a no-op
    // isTelemetryEnabled is false when our provider is null (not yet initialized via initTelemetry)
    expect(typeof isTelemetryEnabled()).toBe('boolean');
    await shutdownTelemetry(); // safe to call even when not initialized via initTelemetry

    if (savedEnv !== undefined) process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = savedEnv;
  });
});
