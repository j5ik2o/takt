/**
 * Tests for StreamDisplay progress info feature
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamDisplay, type ProgressInfo } from '../shared/ui/index.js';

describe('StreamDisplay', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
  });

  describe('progress info display', () => {
    const progressInfo: ProgressInfo = {
      iteration: 3,
      maxIterations: 10,
      movementIndex: 1,
      totalMovements: 4,
    };

    describe('showInit', () => {
      it('should include progress info when provided', () => {
        const display = new StreamDisplay('test-agent', false, progressInfo);
        display.showInit('claude-3');

        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('[test-agent]')
        );
        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('(3/10) step 2/4')
        );
        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('Model: claude-3')
        );
      });

      it('should not include progress info when not provided', () => {
        const display = new StreamDisplay('test-agent', false);
        display.showInit('claude-3');

        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('[test-agent]')
        );
        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('Model: claude-3')
        );
        // Should not contain progress format
        expect(consoleLogSpy).not.toHaveBeenCalledWith(
          expect.stringMatching(/\(\d+\/\d+\) step \d+\/\d+/)
        );
      });

      it('should not display anything in quiet mode', () => {
        const display = new StreamDisplay('test-agent', true, progressInfo);
        display.showInit('claude-3');

        expect(consoleLogSpy).not.toHaveBeenCalled();
      });
    });

    describe('showText', () => {
      it('should include progress info in first text header when provided', () => {
        const display = new StreamDisplay('test-agent', false, progressInfo);
        display.showText('Hello');

        // First call is blank line, second is the header
        expect(consoleLogSpy).toHaveBeenCalledTimes(2);
        expect(consoleLogSpy).toHaveBeenNthCalledWith(2,
          expect.stringContaining('[test-agent]')
        );
        expect(consoleLogSpy).toHaveBeenNthCalledWith(2,
          expect.stringContaining('(3/10) step 2/4')
        );
      });

      it('should not include progress info in header when not provided', () => {
        const display = new StreamDisplay('test-agent', false);
        display.showText('Hello');

        expect(consoleLogSpy).toHaveBeenCalledTimes(2);
        const headerCall = consoleLogSpy.mock.calls[1]?.[0] as string;
        expect(headerCall).toContain('[test-agent]');
        expect(headerCall).not.toMatch(/\(\d+\/\d+\) step \d+\/\d+/);
      });

      it('should output text content to stdout', () => {
        const display = new StreamDisplay('test-agent', false, progressInfo);
        display.showText('Hello');

        expect(stdoutWriteSpy).toHaveBeenCalledWith('Hello');
      });

      it('should not display anything in quiet mode', () => {
        const display = new StreamDisplay('test-agent', true, progressInfo);
        display.showText('Hello');

        expect(consoleLogSpy).not.toHaveBeenCalled();
        expect(stdoutWriteSpy).not.toHaveBeenCalled();
      });
    });

    describe('showThinking', () => {
      it('should include progress info in thinking header when provided', () => {
        const display = new StreamDisplay('test-agent', false, progressInfo);
        display.showThinking('Thinking...');

        expect(consoleLogSpy).toHaveBeenCalledTimes(2);
        expect(consoleLogSpy).toHaveBeenNthCalledWith(2,
          expect.stringContaining('[test-agent]')
        );
        expect(consoleLogSpy).toHaveBeenNthCalledWith(2,
          expect.stringContaining('(3/10) step 2/4')
        );
        expect(consoleLogSpy).toHaveBeenNthCalledWith(2,
          expect.stringContaining('thinking')
        );
      });

      it('should not include progress info in header when not provided', () => {
        const display = new StreamDisplay('test-agent', false);
        display.showThinking('Thinking...');

        expect(consoleLogSpy).toHaveBeenCalledTimes(2);
        const headerCall = consoleLogSpy.mock.calls[1]?.[0] as string;
        expect(headerCall).toContain('[test-agent]');
        expect(headerCall).not.toMatch(/\(\d+\/\d+\) step \d+\/\d+/);
      });

      it('should not display anything in quiet mode', () => {
        const display = new StreamDisplay('test-agent', true, progressInfo);
        display.showThinking('Thinking...');

        expect(consoleLogSpy).not.toHaveBeenCalled();
        expect(stdoutWriteSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('progress prefix format', () => {
    it('should format progress as (iteration/max) step index/total', () => {
      const progressInfo: ProgressInfo = {
        iteration: 5,
        maxIterations: 20,
        movementIndex: 2,
        totalMovements: 6,
      };
      const display = new StreamDisplay('agent', false, progressInfo);
      display.showText('test');

      const headerCall = consoleLogSpy.mock.calls[1]?.[0] as string;
      expect(headerCall).toContain('(5/20) step 3/6');
    });

    it('should convert 0-indexed movementIndex to 1-indexed display', () => {
      const progressInfo: ProgressInfo = {
        iteration: 1,
        maxIterations: 10,
        movementIndex: 0, // First movement (0-indexed)
        totalMovements: 4,
      };
      const display = new StreamDisplay('agent', false, progressInfo);
      display.showText('test');

      const headerCall = consoleLogSpy.mock.calls[1]?.[0] as string;
      expect(headerCall).toContain('step 1/4'); // Should display as 1-indexed
    });
  });
});
