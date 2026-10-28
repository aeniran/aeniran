import assert from "node:assert/strict";
import { test } from "node:test";
import { SseParser } from "../src/sse.js";

test("parses events split across chunks", () => {
  const parser = new SseParser();
  const first = parser.push('event: status\ndata: {"runId":"run-1","status":"RUN');
  assert.deepEqual(first, []);
  const second = parser.push('NING"}\n\nid: 1-0\nevent: assistant\ndata: {"text":"hi"}\n\n');
  assert.deepEqual(second, [
    { event: "status", data: '{"runId":"run-1","status":"RUNNING"}' },
    { id: "1-0", event: "assistant", data: '{"text":"hi"}' },
  ]);
});

test("ignores comments and joins multi-line data", () => {
  const parser = new SseParser();
  const events = parser.push(": keepalive\n\ndata: a\ndata: b\n\n");
  assert.deepEqual(events, [{ event: "message", data: "a\nb" }]);
});

test("handles CRLF line endings and flush", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("event: done\r\ndata: {}\r\n\r\n"), [{ event: "done", data: "{}" }]);
  assert.deepEqual(parser.push("event: result\ndata: {}"), []);
  assert.deepEqual(parser.flush(), [{ event: "result", data: "{}" }]);
});
