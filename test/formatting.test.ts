import assert from "node:assert/strict";
import { test } from "node:test";
import { describeToolCall, formatDuration, formatGit, parseCommand } from "../src/bot.js";
import { splitMessage } from "../src/telegram.js";

test("splitMessage keeps short text intact", () => {
  assert.deepEqual(splitMessage("hello", 10), ["hello"]);
});

test("splitMessage prefers paragraph and line boundaries", () => {
  const text = `${"a".repeat(40)}\n\n${"b".repeat(20)}\n${"c".repeat(30)}`;
  const chunks = splitMessage(text, 70);
  assert.deepEqual(chunks, ["a".repeat(40), `${"b".repeat(20)}\n${"c".repeat(30)}`]);
  for (const chunk of chunks) assert.ok(chunk.length <= 70);

  const lineOnly = `${"a".repeat(30)}\n\n${"b".repeat(30)}\n${"c".repeat(30)}`;
  assert.deepEqual(splitMessage(lineOnly, 70), [`${"a".repeat(30)}\n\n${"b".repeat(30)}`, "c".repeat(30)]);
});

test("splitMessage hard-splits text without separators", () => {
  const chunks = splitMessage("x".repeat(25), 10);
  assert.deepEqual(chunks, ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
});

test("parseCommand handles bot-suffixed commands and arguments", () => {
  assert.deepEqual(parseCommand("/new@my_bot add a readme\nwith details"), {
    command: "new",
    args: "add a readme\nwith details",
  });
  assert.deepEqual(parseCommand("/Status"), { command: "status", args: "" });
  assert.equal(parseCommand("just a message"), undefined);
  assert.equal(parseCommand("not /a command"), undefined);
});

test("describeToolCall picks a useful argument and clips it", () => {
  assert.equal(
    describeToolCall({ name: "run_terminal_cmd", status: "running", args: { command: "npm test" } }),
    "run_terminal_cmd npm test ...",
  );
  const long = describeToolCall({ name: "read_file", status: "completed", args: { path: "p".repeat(100) } });
  assert.ok(long.length <= "read_file ".length + 80);
  assert.ok(long.endsWith("..."));
});

test("formatGit lists branches and PRs", () => {
  assert.equal(formatGit(undefined), "");
  assert.equal(
    formatGit([{ repoUrl: "github.com/o/r", branch: "cursor/x", prUrl: "https://github.com/o/r/pull/1" }]),
    "Branch: cursor/x on github.com/o/r\nPR: https://github.com/o/r/pull/1",
  );
});

test("formatDuration", () => {
  assert.equal(formatDuration(12_357), "12s");
  assert.equal(formatDuration(125_000), "2m 5s");
});
