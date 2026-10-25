import { SSE_MAX_BYTES, SseParser } from './sse-parser';

describe('SseParser size cap', () => {
  it('drops an oversized frame (many lines or one huge line) and keeps working after it', () => {
    const p = new SseParser();
    const big = 'x'.repeat(SSE_MAX_BYTES / 2);
    expect(p.feed(`event: a\ndata: ${big}\ndata: ${big}\ndata: ${big}\n\nevent: ok\ndata: 1\n\n`)).toEqual([{ event: 'ok', data: '1', id: null }]);
  });

  it('cuts a line that never ends, in chunks, then recovers at the next lines', () => {
    const p = new SseParser();
    const out = [];
    out.push(...p.feed('event: a\ndata: '));
    for (let i = 0; i < 5; i++) out.push(...p.feed('y'.repeat(SSE_MAX_BYTES / 2)));
    out.push(...p.feed('tail\n\nevent: ok\ndata: 2\n\n'));
    expect(out).toEqual([{ event: 'ok', data: '2', id: null }]);
  });
});

describe('SseParser', () => {
  it('reads retry first, then a frame with an id', () => {
    const p = new SseParser();
    const frames = p.feed('retry: 4000\nevent: hello\ndata: {"replayed":false}\n\nid: abc\nevent: page-shared\ndata: {"pageId":"p1"}\n\n');
    expect(p.retry).toBe(4000);
    expect(frames).toEqual([
      { event: 'hello', data: '{"replayed":false}', id: null },
      { event: 'page-shared', data: '{"pageId":"p1"}', id: 'abc' },
    ]);
  });

  it('assembles a frame split across arbitrary chunks, down to one character', () => {
    const text = 'id: x1\nevent: block-revealed\ndata: {"pageId":"p","blockIds":["b"]}\n\n';
    const p = new SseParser();
    const out = [...text].flatMap((ch) => p.feed(ch));
    expect(out).toEqual([{ event: 'block-revealed', data: '{"pageId":"p","blockIds":["b"]}', id: 'x1' }]);
  });

  it('joins multi-line data with newlines', () => {
    const frames = new SseParser().feed('event: m\ndata: one\ndata: two\ndata:\ndata: four\n\n');
    expect(frames[0]?.data).toBe('one\ntwo\n\nfour');
  });

  it('accepts CRLF, CR and LF line endings, also a CRLF split between chunks', () => {
    const p = new SseParser();
    expect(p.feed('event: a\r\ndata: 1\r\n\r\n')).toHaveLength(1);
    expect(p.feed('event: b\rdata: 2\r\r')).toEqual([]);
    expect(p.feed('\n')).toEqual([{ event: 'b', data: '2', id: null }]);
    const q = new SseParser();
    expect(q.feed('event: c\r')).toEqual([]);
    expect(q.feed('\ndata: 3\r')).toEqual([]);
    expect(q.feed('\n\r')).toEqual([]);
    expect(q.feed('\n')).toEqual([{ event: 'c', data: '3', id: null }]);
  });

  it('dispatches an empty data field (ping) and ignores comments and unknown fields', () => {
    const frames = new SseParser().feed(': keep-alive\nfoo: bar\nevent: ping\ndata:\n\n');
    expect(frames).toEqual([{ event: 'ping', data: '', id: null }]);
  });

  it('does not dispatch a block without data and does not leak fields into the next frame', () => {
    const p = new SseParser();
    const frames = p.feed('id: lost\nevent: ghost\n\nevent: real\ndata: 1\n\n');
    expect(frames).toEqual([{ event: 'real', data: '1', id: null }]);
  });

  it('defaults the name to message, strips one leading space and a BOM, and rejects a bad retry', () => {
    const p = new SseParser();
    const frames = p.feed('﻿data:  two spaces\nretry: soon\n\n');
    expect(frames).toEqual([{ event: 'message', data: ' two spaces', id: null }]);
    expect(p.retry).toBeNull();
  });

  it('ignores an id with a NUL and keeps the retry value of the latest valid line', () => {
    const p = new SseParser();
    const frames = p.feed('retry: 1000\nretry: 2500\nid: a\0b\ndata: x\n\n');
    expect(frames[0]?.id).toBeNull();
    expect(p.retry).toBe(2500);
  });
});
