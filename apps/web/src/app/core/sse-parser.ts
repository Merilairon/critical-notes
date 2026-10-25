/** Largest frame (and longest unterminated line) accepted; anything bigger is dropped, never parsed. */
export const SSE_MAX_BYTES = 64 * 1024;

/** One dispatched server-sent event. `id` is only set when this very frame carried an `id:` line (control events carry none). */
export interface SseFrame {
  event: string;
  data: string;
  id: string | null;
}

/**
 * Incremental parser for the text/event-stream format (WHATWG "Server-sent events", section "Parsing an event stream").
 * Feed it decoded text in chunks of any size; it returns the frames completed by that chunk. Handles lines split across
 * chunks, CRLF / LF / CR endings (also a CR LF pair split between two chunks), comments, multi-line `data:`, a
 * leading BOM, and exposes the last `retry:` value (milliseconds) as soon as its line is parsed.
 */
export class SseParser {
  /** Latest valid `retry:` value in milliseconds, or null when the server sent none. */
  retry: number | null = null;
  private buffer = '';
  private started = false;
  private event = '';
  private data: string[] = [];
  private hasData = false;
  private id: string | null = null;
  private dataSize = 0;
  /** The frame being built grew past SSE_MAX_BYTES: it is dropped at its blank line. */
  private oversized = false;
  /** An unterminated line grew past the cap and was cut: skip the rest of that line. */
  private skipRest = false;

  feed(chunk: string): SseFrame[] {
    this.buffer += chunk;
    if (!this.started && this.buffer.length > 0) {
      this.started = true;
      if (this.buffer.charCodeAt(0) === 0xfeff) this.buffer = this.buffer.slice(1);
    }
    const frames: SseFrame[] = [];
    let start = 0;
    for (;;) {
      const end = this.lineEnd(start);
      if (!end) break;
      if (this.skipRest) this.skipRest = false;
      else {
        const frame = this.line(this.buffer.slice(start, end.at));
        if (frame) frames.push(frame);
      }
      start = end.next;
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length > SSE_MAX_BYTES) {
      // A line that never ends: forget it, poison the frame, ignore the rest of the line
      this.buffer = '';
      this.skipRest = true;
      this.oversized = true;
    }
    return frames;
  }

  /** Finds the next complete line end at or after `from`. A CR at the very end waits for the next chunk (it may be half of CRLF). */
  private lineEnd(from: number): { at: number; next: number } | null {
    for (let i = from; i < this.buffer.length; i++) {
      const c = this.buffer.charCodeAt(i);
      if (c === 10) return { at: i, next: i + 1 };
      if (c === 13) {
        if (i + 1 >= this.buffer.length) return null;
        return { at: i, next: this.buffer.charCodeAt(i + 1) === 10 ? i + 2 : i + 1 };
      }
    }
    return null;
  }

  private line(line: string): SseFrame | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    this.dataSize += line.length;
    if (this.dataSize > SSE_MAX_BYTES) this.oversized = true;
    if (this.oversized) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.event = value;
        break;
      case 'data':
        this.data.push(value);
        this.hasData = true;
        break;
      case 'id':
        if (!value.includes('\0')) this.id = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
    }
    return null;
  }

  private dispatch(): SseFrame | null {
    const frame: SseFrame | null = this.hasData && !this.oversized ? { event: this.event || 'message', data: this.data.join('\n'), id: this.id } : null;
    this.event = '';
    this.data = [];
    this.hasData = false;
    this.id = null;
    this.dataSize = 0;
    this.oversized = false;
    return frame;
  }
}
