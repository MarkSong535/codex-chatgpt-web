import { expect, spyOn, test } from "bun:test";
import { mock } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptBrowserWorker, chatGptSuspensionClock } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError, chatGptRetainedConversationUnavailableError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  cancelAllStructuredCompactions,
  cancelStructuredCompactionNativeTurn,
  cancelStructuredCompactionTrace,
  existingStructuredCompactionRun,
  requestRetainedCompactionHandoff,
  runStructuredCompactionOnce,
  settleActiveCompactionSource,
} from "../src/adapters/chatgpt-web/compaction-handoff";
import { CompactionTransactionStore } from "../src/adapters/chatgpt-web/compaction-transaction";
import {
  chatGptConversationKey,
  retainedConversationResumeRequest,
} from "../src/adapters/chatgpt-web/conversation-key";
import {
  chatGptWebExecutionNamespace,
  createChatGptWebAdapter,
} from "../src/adapters/chatgpt-web/index";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSession,
  ChatGptTurnSessions,
  chatGptCompactionSourceExecutionKey,
  chatGptTurnExecutionKey,
  chatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";
import {
  callTurnBroker,
  TurnBroker,
  type BrokerToolResult,
} from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import {
  CODEX_ACTIVE_COMPACTION_REQUEST_MARKER,
  structuredCompactionHandoffInstruction,
} from "../src/adapters/chatgpt-web/native-compaction-control";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

/**
 * These fixtures hand the turn broker a Unix socket under their temp root. macOS puts TMPDIR at
 * /var/folders/<32 chars>/T, which pushes `<root>/runtime/turn-broker.sock` past the 104-byte
 * sun_path limit, and listen() then fails with nothing but "Failed to listen". Root them somewhere
 * short so the socket is bindable.
 */
function shortSocketTempRoot(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

function request(compaction = false): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: {
      messages: [
        { role: "user", content: "Original task", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Work completed" }], timestamp: 2 },
        { role: "user", content: "Continue with the next step", timestamp: 3 },
      ],
    },
    options: { reasoning: "high" },
    _compactionRequest: compaction,
    _rawBody: {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue with the next step" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_source" },
      }],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_retained_compaction",
          turn_id: compaction ? "turn_compact" : "turn_source",
        }),
      },
    },
  };
}

function controlBinding(instruction: string): { token: string; handoffId: string } {
  const token = instruction.match(/turn_token (turn_[a-f0-9]{32})/)?.[1];
  const handoffId = instruction.match(/handoff_id (handoff_[a-f0-9]{32})/)?.[1];
  if (!token || !handoffId) throw new Error(`Missing compaction control binding: ${instruction}`);
  return { token, handoffId };
}

test("one browser conversation spans native turns and rotates only at compaction", () => {
  const before = request(false);
  const sameTurn = structuredClone(before);
  (sameTurn._rawBody as { input: unknown[] }).input.push({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Same native turn revision" }],
  });
  const nextTurn = structuredClone(before);
  (nextTurn._rawBody as { client_metadata: Record<string, unknown> }).client_metadata = {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "thread_retained_compaction",
      turn_id: "turn_next",
    }),
  };
  const afterCompact = structuredClone(before);
  (afterCompact._rawBody as { input: unknown[] }).input.unshift({
    type: "compaction",
    encrypted_content: "ocx1:checkpoint",
  });

  expect(chatGptConversationKey(sameTurn, "provider")).toBe(chatGptConversationKey(before, "provider"));
  expect(chatGptConversationKey(nextTurn, "provider")).toBe(chatGptConversationKey(before, "provider"));
  expect(chatGptConversationKey(afterCompact, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  const otherModel = structuredClone(before);
  otherModel.modelId = "chatgpt-web/pro";
  expect(chatGptConversationKey(otherModel, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  const otherEffort = structuredClone(before);
  otherEffort.options.reasoning = "medium";
  expect(chatGptConversationKey(otherEffort, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  const otherThread = structuredClone(before);
  (otherThread._rawBody as { client_metadata: Record<string, unknown> }).client_metadata = {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "thread_other",
      turn_id: "turn_source",
    }),
  };
  expect(chatGptConversationKey(otherThread, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  expect(retainedConversationResumeRequest(before)?.context.messages).toEqual([
    { role: "user", content: "Continue with the next step", timestamp: 3 },
  ]);

  const v1Compact = structuredClone(before);
  (v1Compact._rawBody as { input: unknown[] }).input.unshift({
    role: "user",
    content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\ncheckpoint` }],
  });
  expect(chatGptConversationKey(v1Compact, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
});

test("compaction capability is one-shot and structurally bound to its handoff id", async () => {
  const store = new CompactionTransactionStore();
  const transaction = store.begin("trace_compaction", 1_000);
  expect(() => store.submit(transaction.token, "handoff_wrong", "checkpoint")).toThrow("does not match");
  store.submit(transaction.token, transaction.handoffId, "  exact checkpoint  ");
  await expect(store.wait(transaction.token)).resolves.toBe("exact checkpoint");
  expect(() => store.submit(transaction.token, transaction.handoffId, "again")).toThrow("invalid, expired, or consumed");
  store.close();
});

test("retained compaction provides one exact same-agent control binding", () => {
  const prompt = structuredCompactionHandoffInstruction({
    token: "turn_11111111111111111111111111111111",
    handoffId: "handoff_22222222222222222222222222222222",
  }, "Codex app");
  expect(prompt).toContain('selected ChatGPT plugin "Codex app"');
  expect(prompt).not.toContain("Codex Native");
  expect(prompt).toContain("Automatic Codex context compaction has started.");
  expect(prompt).toContain("Stop ordinary task work");
  expect(prompt).toContain("turn_token turn_11111111111111111111111111111111");
  expect(prompt).toContain("wire_name codex.control.compaction_handoff");
  expect(prompt).toContain('"handoff_id":"handoff_22222222222222222222222222222222"');
  expect(prompt).toContain("do not use it with codex_exec, codex_tool_inventory, or any outer Codex tool");
  expect(prompt).toContain("submitted=true");
});

test("a compaction control token cannot claim the ordinary Codex tool environment", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-compaction-capability-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const transaction = await broker.beginCompactionTransaction("trace_capability", 1_000);
    await expect(callTurnBroker(broker.socketPath, {
      method: "claim",
      token: transaction.token,
    })).rejects.toThrow("turn token is invalid");
    await callTurnBroker(broker.socketPath, {
      method: "submit_compaction_handoff",
      token: transaction.token,
      handoffId: transaction.handoffId,
      summary: "Bound checkpoint",
    });
    await expect(broker.waitForCompactionHandoff(transaction.token)).resolves.toBe("Bound checkpoint");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained compaction submits through the published MCP contract with no ordinary tool authority", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-compaction-mcp-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const client = new Client({ name: "compaction-contract-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--broker-socket", broker.socketPath],
    cwd: process.cwd(), stderr: "pipe",
  });
  const sourceRequest = request(false);
  const source = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    usageInput: sourceRequest, conversationKey: chatGptConversationKey(sourceRequest, "provider")!, cancel() {},
  });
  try {
    await client.connect(transport);
    const run = async (turn: BrowserTurn) => {
      const prepared = await turn.prepare();
      try {
        const { token, handoffId } = controlBinding(prepared.text);
        const result = await client.callTool({ name: "codex_tool_call", arguments: {
          turn_token: token, wire_name: "codex.control.compaction_handoff",
          arguments: { handoff_id: handoffId, summary: "Complete checkpoint sent through MCP" },
        } });
        if (result.isError) throw new Error(JSON.stringify(result.content));
        return "Checkpoint submitted.";
      } finally { prepared.release(); }
    };
    const summary = await requestRetainedCompactionHandoff(
      { appName: "Codex app", run } as never, request(true), source, broker,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      "trace_mcp_handoff",
    );
    expect(summary).toBe("Complete checkpoint sent through MCP");

    const transaction = await broker.beginCompactionTransaction("trace_mcp_boundaries", 30_000);
    for (const [name, args] of [
      ["codex_exec", { cmd: "echo must-not-run" }],
      ["codex_tool_inventory", {}],
      ["codex_tool_call", { wire_name: "exec_command", arguments: { cmd: "echo must-not-run" } }],
    ] as const) {
      const denied = await client.callTool({ name, arguments: { turn_token: transaction.token, ...args } });
      expect(denied.isError).toBeTrue();
      expect(JSON.stringify(denied.content)).toContain("turn token is invalid");
    }
    const submit = (token: string, handoffId: string) => client.callTool({ name: "codex_tool_call", arguments: {
      turn_token: token, wire_name: "codex.control.compaction_handoff",
      arguments: { handoff_id: handoffId, summary: "Bound checkpoint" },
    } });
    const wrong = await submit(transaction.token, "handoff_wrong");
    expect(wrong.isError).toBeTrue();
    expect(JSON.stringify(wrong.content)).toContain("does not match");
    const ordinary = await broker.register({ cwd: root, roots: [root], writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" }, tools: [] }, 30_000);
    expect((await submit(ordinary, transaction.handoffId)).isError).toBeTrue();
    expect((await submit(transaction.token, transaction.handoffId)).isError).not.toBeTrue();
    expect(await broker.waitForCompactionHandoff(transaction.token)).toBe("Bound checkpoint");
    expect((await submit(transaction.token, transaction.handoffId)).isError).toBeTrue();
    const aborted = await broker.beginCompactionTransaction("trace_mcp_aborted", 30_000);
    broker.abortCompactionTransaction(aborted.token);
    expect((await submit(aborted.token, aborted.handoffId)).isError).toBeTrue();
  } finally {
    await client.close();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("active compaction delivers the current result and converts every later MCP call into the checkpoint request", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-active-compaction-gate-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [{
        name: "exec_command",
        description: "Run one command",
        parameters: { type: "object" },
      }],
    // The assertion exercises compaction routing, not expiry. Leave enough lease headroom for
    // Windows named-pipe scheduling under the full parallel test suite.
    }, 30_000, "trace_active_compaction");
    const claimed = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim",
      token,
    });
    const current = callTurnBroker<BrokerToolResult>(broker.socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "pwd" },
    });
    const [request] = await broker.nextToolBatch(token);
    let progressEvents = 0;
    broker.requestCompaction(token, {
      content: [{ type: "text", text: "compact now" }],
      isError: true,
    }, () => { progressEvents++; });
    expect(progressEvents).toBe(0);
    broker.completeTool(token, request!.callId, {
      content: [{ type: "text", text: "current result" }],
    });
    await expect(current).resolves.toMatchObject({
      content: [{ type: "text", text: "current result" }],
    });
    await expect(callTurnBroker(broker.socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "git status --short" },
    })).resolves.toMatchObject({
      content: [{ type: "text", text: "compact now" }],
      isError: true,
    });
    expect(progressEvents).toBe(1);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("active compaction drains an MCP call already queued without an outer Codex waiter", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-queued-before-compaction-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [{
        name: "exec_command",
        description: "Run one command",
        parameters: { type: "object" },
      }],
    }, 10_000, "trace_prequeued_compaction");
    const claimed = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim",
      token,
    });
    const invocation = callTurnBroker<BrokerToolResult>(broker.socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "must-not-run" },
    });
    await Bun.sleep(25);
    const interrupted = broker.requestCompaction(token, {
      content: [{ type: "text", text: "compact instead" }],
      isError: true,
    });
    expect(interrupted).toBe(1);
    await expect(invocation).resolves.toMatchObject({
      content: [{ type: "text", text: "compact instead" }],
      isError: true,
    });
    expect(broker.compactionDeliveryCount(token)).toBe(1);
    broker.revoke(token);
    expect(() => broker.compactionDeliveryCount(token)).toThrow("turn capability retired");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["5.6", "6"] as const)("a retained %s checkpoint preserves model selection and physically retires its browser", async family => {
  expect(MAX_COMPACTION_HANDOFF_TIMEOUT_MS).toBe(5 * 60_000);
  const sourceRequest = { ...request(false), _chatgptModelFamily: family };
  const compactRequest = { ...request(true), _chatgptModelFamily: family };
  const conversationKey = chatGptConversationKey(sourceRequest, "provider")!;
  const source = new ChatGptTurnSession({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey,
    cancel() {},
  });
  let captured: BrowserTurn | undefined;
  let browserRetired = false;
  let transactionAborted = false;
  let transactionTtl = 0;
  const broker = {
    beginCompactionTransaction: async (_traceId: string, ttlMs: number) => {
      transactionTtl = ttlMs;
      return {
      token: "turn_11111111111111111111111111111111",
      handoffId: "handoff_22222222222222222222222222222222",
      };
    },
    waitForCompactionHandoff: async () => "Retained agent checkpoint",
    abortCompactionTransaction: () => { transactionAborted = true; },
  } as unknown as TurnBroker;
  const worker = {
    appName: "Codex app",
    run: async (turn: BrowserTurn): Promise<string> => {
      captured = turn;
      const prepared = await turn.prepareResume!();
      expect(prepared.text).toContain('selected ChatGPT plugin "Codex app"');
      expect(prepared.text).toContain("wire_name codex.control.compaction_handoff");
      prepared.release();
      return await new Promise<string>((_resolve, reject) => {
        const onAbort = () => {
          browserRetired = true;
          reject(new DOMException("retained handoff browser closed", "AbortError"));
        };
        if (turn.abortSignal?.aborted) onAbort();
        else turn.abortSignal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };

  await expect(requestRetainedCompactionHandoff(
    worker as never,
    compactRequest,
    source,
    broker,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "trace_handoff",
    undefined,
    60 * 60_000,
  )).resolves.toBe("Retained agent checkpoint");
  expect(captured?.modelFamily).toBe(family);
  expect(captured?.conversationKey).toBe(conversationKey);
  expect(captured?.requireRetainedConversation).toBeTrue();
  expect(captured?.compaction).toBeTrue();
  expect(captured?.nativeConnector).toBeTrue();
  expect(captured?.capabilities.localToolsEnabled).toBeFalse();
  expect(browserRetired).toBeTrue();
  expect(captured?.abortSignal?.reason).toBeInstanceOf(ChatGptCompactionHandoffAccepted);
  expect(transactionAborted).toBeTrue();
  expect(transactionTtl).toBe(MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
});

test("completed retained compaction never treats ordinary assistant text as a handoff", async () => {
  const sourceRequest = request(false);
  const source = new ChatGptTurnSession({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey: chatGptConversationKey(sourceRequest, "provider")!,
    cancel() {},
  });
  const broker = {
    beginCompactionTransaction: async () => ({
      token: "turn_11111111111111111111111111111111",
      handoffId: "handoff_22222222222222222222222222222222",
    }),
    waitForCompactionHandoff: async () => { throw new Error("structured handoff missing"); },
    abortCompactionTransaction() {},
  } as unknown as TurnBroker;
  const worker = {
    appName: "Codex app",
    run: async () => '{"checkpoint":"must never be parsed"}',
  };

  await expect(requestRetainedCompactionHandoff(
    worker as never,
    request(true),
    source,
    broker,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "trace_no_text_fallback",
  )).rejects.toThrow("structured handoff missing");
});

test("a settled browser response without a checkpoint reports the missing handoff immediately", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-missing-handoff-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const sourceRequest = request(false);
  const source = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    usageInput: sourceRequest, conversationKey: chatGptConversationKey(sourceRequest, "provider")!, cancel() {},
  });
  const abort = new AbortController();
  const guard = setTimeout(() => abort.abort(new Error("test observation guard")), 1000);
  try {
    await expect(requestRetainedCompactionHandoff(
      { appName: "Codex app", run: async () => "The requested tool call did not run." } as never,
      request(true), source, broker,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      "trace_missing_handoff", abort.signal,
    )).rejects.toMatchObject({ code: "compaction_handoff_missing", retryable: false });
  } finally {
    clearTimeout(guard);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a checkpoint submitted before browser completion wins the terminal response race", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-handoff-race-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const sourceRequest = request(false);
  const source = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    usageInput: sourceRequest, conversationKey: chatGptConversationKey(sourceRequest, "provider")!, cancel() {},
  });
  try {
    await expect(requestRetainedCompactionHandoff(
      { appName: "Codex app", run: async (turn: BrowserTurn) => {
        const prepared = await turn.prepare();
        const token = prepared.text.match(/turn_token (turn_\w+)/)![1]!;
        const handoffId = prepared.text.match(/handoff_id (handoff_\w+)/)![1]!;
        await callTurnBroker(broker.socketPath, { method: "submit_compaction_handoff", token, handoffId, summary: "Exact summary" });
        prepared.release();
        return "Checkpoint submitted.";
      } } as never,
      request(true), source, broker,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      "trace_handoff_race",
    )).resolves.toBe("Exact summary");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained compaction deadline bounds browser settlement after the control handoff succeeds", async () => {
  const sourceRequest = request(false);
  const source = new ChatGptTurnSession({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey: chatGptConversationKey(sourceRequest, "provider")!,
    cancel() {},
  });
  let transactionAborted = false;
  const broker = {
    beginCompactionTransaction: async () => ({
      token: "turn_11111111111111111111111111111111",
      handoffId: "handoff_22222222222222222222222222222222",
    }),
    waitForCompactionHandoff: async () => "Already submitted checkpoint",
    abortCompactionTransaction: () => { transactionAborted = true; },
  } as unknown as TurnBroker;
  const worker = {
    appName: "Codex app",
    run: async () => new Promise<string>(() => {}),
  };

  await expect(requestRetainedCompactionHandoff(
    worker as never,
    request(true),
    source,
    broker,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "trace_deadline",
    undefined,
    25,
  )).rejects.toThrow("timed out after 25ms");
  expect(transactionAborted).toBeTrue();
});

test("a rejected exact compaction run is evicted while a successful run remains replayable", async () => {
  const key = `exact-retry-${Date.now()}-${Math.random()}`;
  const owner = { ownerKey: `owner-${key}`, traceIds: [`trace-${key}`] };
  let starts = 0;
  await expect(runStructuredCompactionOnce(key, owner, async () => {
    starts += 1;
    throw new Error("first handoff failed");
  })).rejects.toThrow("first handoff failed");
  await Bun.sleep(0);
  expect(existingStructuredCompactionRun(key)).toBeUndefined();

  const retry = runStructuredCompactionOnce(key, owner, async () => {
    starts += 1;
    return "recovered checkpoint";
  });
  expect(runStructuredCompactionOnce(key, owner, async () => "must not start")).toBe(retry);
  await expect(retry).resolves.toBe("recovered checkpoint");
  await expect(existingStructuredCompactionRun(key)).resolves.toBe("recovered checkpoint");
  expect(starts).toBe(2);
});

test("an exact oversized compaction replays its size error instead of uploading the same parts again", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-size-compact-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://oversized-${crypto.randomUUID()}`,
    chatgptWeb: {
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
      experimentalBiggerContext: true,
      experimentalFreshConversationPerTurn: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  let browserStarts = 0;
  worker.run = async turn => {
    browserStarts++;
    const prepared = await turn.prepare();
    prepared.release();
    throw new ChatGptWebAdapterError("The submitted message is too long", {
      status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false,
    });
  };
  const adapter = createChatGptWebAdapter(provider);
  const observe = async (input: CodexParsedRequest) => {
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(input, { headers: new Headers() }, event => events.push(event));
    expect(events.at(-1)).toMatchObject({
      type: "error", status: 400, code: "context_length_exceeded", retryable: false,
    });
    expect(events.some(event => event.type === "done")).toBeFalse();
  };
  try {
    await observe(request(true));
    await Bun.sleep(0);
    await observe(request(true));
    expect(browserStarts).toBe(1);

    // Changed input and model selection must reach the browser again.
    const revised = request(true);
    revised.context.messages.at(-1)!.content = "Continue";
    (revised._rawBody as { input: Array<{ content: Array<{ text: string }> }> }).input[0]!.content[0]!.text = "Continue";
    await observe(revised);
    expect(browserStarts).toBe(2);
    const otherMode = request(true);
    otherMode.options.reasoning = "max";
    await observe(otherMode);
    expect(browserStarts).toBe(3);
  } finally {
    worker.run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator cancellation aborts the shared structured compaction owner", async () => {
  const key = `operator-cancel-${Date.now()}-${Math.random()}`;
  const traceId = `trace-${key}`;
  let aborted = false;
  const run = runStructuredCompactionOnce(
    key,
    { ownerKey: `owner-${key}`, traceIds: [traceId] },
    signal => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  );
  await Bun.sleep(0);
  expect(await cancelStructuredCompactionTrace(traceId, new Error("operator cancelled"))).toBe(1);
  await expect(run).rejects.toThrow("operator cancelled");
  expect(aborted).toBeTrue();
  expect(existingStructuredCompactionRun(key)).toBeUndefined();
});

test("native interruption before registration prevents the detached compaction from starting", async () => {
  const key = `interrupt-before-registration-${Date.now()}-${Math.random()}`;
  const owner = {
    ownerKey: `owner-${key}`,
    traceIds: [`trace-${key}`],
    nativeThreadId: `thread-${key}`,
    nativeTurnId: `turn-${key}`,
  };
  const reason = new DOMException("Codex turn interrupted", "AbortError");

  const cancellation = cancelStructuredCompactionNativeTurn(
    owner.nativeThreadId,
    owner.nativeTurnId,
    reason,
  );
  expect(cancellation.cancelled).toBe(0);
  await cancellation.settlement;
  const duplicateCancellation = cancelStructuredCompactionNativeTurn(
    owner.nativeThreadId,
    owner.nativeTurnId,
    new Error("duplicate interrupt must not replace the first reason"),
  );
  expect(duplicateCancellation.cancelled).toBe(0);
  await duplicateCancellation.settlement;
  const unrelatedSettlements: Promise<void>[] = [];
  for (let index = 0; index < 1_025; index += 1) {
    const unrelated = cancelStructuredCompactionNativeTurn(
      `thread-unrelated-${key}-${index}`,
      `turn-unrelated-${key}-${index}`,
      new Error(`unrelated interrupt ${index}`),
    );
    unrelatedSettlements.push(unrelated.settlement);
  }
  await Promise.all(unrelatedSettlements);

  let started = false;
  const run = runStructuredCompactionOnce(key, owner, async () => {
    started = true;
    return "must not start";
  });

  await expect(run).rejects.toBe(reason);
  expect(started).toBeFalse();
  expect(existingStructuredCompactionRun(key)).toBeUndefined();

  let unrelatedStarted = false;
  await expect(runStructuredCompactionOnce(
    `${key}-unrelated`,
    {
      ...owner,
      ownerKey: `${owner.ownerKey}-unrelated`,
      nativeTurnId: `${owner.nativeTurnId}-unrelated`,
    },
    async () => {
      unrelatedStarted = true;
      return "unrelated checkpoint";
    },
  )).resolves.toBe("unrelated checkpoint");
  expect(unrelatedStarted).toBeTrue();
});

test("a completed exact compaction remains replayable after a later native interruption", async () => {
  const key = `completed-before-interrupt-${Date.now()}-${Math.random()}`;
  const owner = {
    ownerKey: `owner-${key}`,
    traceIds: [`trace-${key}`],
    nativeThreadId: `thread-${key}`,
    nativeTurnId: `turn-${key}`,
  };
  const completed = runStructuredCompactionOnce(key, owner, async () => "canonical checkpoint");
  await expect(completed).resolves.toBe("canonical checkpoint");

  const cancellation = cancelStructuredCompactionNativeTurn(
    owner.nativeThreadId,
    owner.nativeTurnId,
    new DOMException("Codex turn interrupted", "AbortError"),
  );
  expect(cancellation.cancelled).toBe(0);
  await cancellation.settlement;

  let restarted = false;
  const replay = runStructuredCompactionOnce(key, owner, async () => {
    restarted = true;
    return "must not replace canonical checkpoint";
  });
  expect(replay).toBe(completed);
  await expect(replay).resolves.toBe("canonical checkpoint");
  expect(restarted).toBeFalse();
});

test("a duplicate native interruption refreshes its lifetime without replacing its reason", async () => {
  const originalNow = Date.now;
  const key = `duplicate-interrupt-refresh-${originalNow()}-${Math.random()}`;
  const initialNow = 1_000_000_000;
  let now = initialNow;
  Date.now = () => now;
  try {
    const owner = {
      ownerKey: `owner-${key}`,
      traceIds: [`trace-${key}`],
      nativeThreadId: `thread-${key}`,
      nativeTurnId: `turn-${key}`,
    };
    const originalReason = new DOMException("first Codex turn interruption", "AbortError");
    cancelStructuredCompactionNativeTurn(owner.nativeThreadId, owner.nativeTurnId, originalReason);

    now = initialNow + (29 * 60_000) + 59_000;
    cancelStructuredCompactionNativeTurn(
      owner.nativeThreadId,
      owner.nativeTurnId,
      new Error("duplicate reason must not become authoritative"),
    );

    now = initialNow + (30 * 60_000) + 1_000;
    let started = false;
    const run = runStructuredCompactionOnce(key, owner, async () => {
      started = true;
      return "must not start";
    });
    await expect(run).rejects.toBe(originalReason);
    expect(started).toBeFalse();
  } finally {
    Date.now = originalNow;
  }
});

test("structured compaction rejects incomplete native interruption identities", () => {
  const reason = new DOMException("Codex turn interrupted", "AbortError");
  expect(() => cancelStructuredCompactionNativeTurn(" ", "turn_valid", reason))
    .toThrow("non-empty native thread and turn ids");
  expect(() => runStructuredCompactionOnce(
    `incomplete-native-owner-${Date.now()}-${Math.random()}`,
    { ownerKey: "incomplete-native-owner", traceIds: [], nativeThreadId: "thread_valid" },
    async () => "must not start",
  )).toThrow("non-empty native thread and turn ids");
});

test("active compaction settles canonical tool results before the separate retained handoff", async () => {
  const completed: Array<{ callId: string; result: BrokerToolResult }> = [];
  const compactionTokens: string[] = [];
  let finishBrowser!: (answer: string) => void;
  const browser = new Promise<string>(resolve => { finishBrowser = resolve; });
  const broker = {
    requestCompaction: (token: string) => { compactionTokens.push(token); return 0; },
    compactionDeliveryCount: () => 0,
    completeTool: async (_token: string, callId: string, result: BrokerToolResult) => {
      completed.push({ callId, result });
      if (callId === "call_two") {
        finishBrowser("Ordinary final after canonical results.");
      }
    },
    revoke() {},
  } as unknown as TurnBroker;
  const source = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_active"),
    externalProgress: {
      recordToolResult() {},
    } as never,
    browser,
    physicalSettlement: browser.then(() => undefined),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() {},
  });
  source.setOutstanding([
    { callId: "call_one", wireName: "exec_command", freeform: false },
    { callId: "call_two", wireName: "exec_command", freeform: false },
  ]);
  const parsed = request(true);
  parsed.context.messages.push(
    { role: "toolResult", toolCallId: "call_one", toolName: "exec_command", content: "one", isError: false, timestamp: 4 },
    { role: "toolResult", toolCallId: "call_two", toolName: "exec_command", content: "two", isError: false, timestamp: 5 },
  );

  await expect(settleActiveCompactionSource(parsed, source, broker)).resolves.toEqual({
    answer: "Ordinary final after canonical results.",
    compactionInstructionDelivered: false,
  });
  expect(compactionTokens).toEqual(["turn_active"]);
  expect(completed.map(entry => entry.callId)).toEqual(["call_one", "call_two"]);
  expect(JSON.stringify(completed[0])).not.toContain(CODEX_ACTIVE_COMPACTION_REQUEST_MARKER);
  expect(JSON.stringify(completed[1])).not.toContain(CODEX_ACTIVE_COMPACTION_REQUEST_MARKER);
  expect(JSON.stringify(completed[1])).not.toContain("codex.control.compaction_handoff");
  expect(completed[1]!.result.content).toEqual([{ type: "text", text: "two" }]);
});

test("active compaction distinguishes a later intercepted tool from an ordinary post-result final", async () => {
  let finishBrowser!: (answer: string) => void;
  const browser = new Promise<string>(resolve => { finishBrowser = resolve; });
  let compactionDeliveries = 0;
  const broker = {
    requestCompaction: () => 0,
    compactionDeliveryCount: () => compactionDeliveries,
    completeTool: async (_token: string, _callId: string, result: BrokerToolResult) => {
      expect(result.content).toEqual([{ type: "text", text: "canonical result" }]);
      compactionDeliveries = 1;
      finishBrowser("Stopped after the bridge rejected a later tool call.");
    },
    revoke() {},
  } as unknown as TurnBroker;
  const source = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_active_later_tool"),
    externalProgress: { recordToolResult() {} } as never,
    browser,
    physicalSettlement: browser.then(() => undefined),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() {},
  });
  source.setOutstanding([{
    callId: "call_current",
    wireName: "exec_command",
    freeform: false,
  }]);
  const parsed = request(true);
  parsed.context.messages.push({
    role: "toolResult",
    toolCallId: "call_current",
    toolName: "exec_command",
    content: "canonical result",
    isError: false,
    timestamp: 4,
  });

  await expect(settleActiveCompactionSource(parsed, source, broker)).resolves.toEqual({
    answer: "Stopped after the bridge rejected a later tool call.",
    compactionInstructionDelivered: true,
  });
});

test("active compaction waits for an ordinary response with no available tool boundary", async () => {
  const browser = Promise.resolve("The ordinary response reached its terminal boundary.");
  let requested = 0;
  const broker = {
    requestCompaction: () => { requested += 1; return 0; },
    compactionDeliveryCount: () => 0,
    completeTool() { throw new Error("no tool result should be delivered"); },
    revoke() {},
  } as unknown as TurnBroker;
  const source = new ChatGptTurnSession({
    mode: "tools", token: Promise.resolve("turn_active_without_boundary"),
    externalProgress: { recordToolResult() {} } as never,
    browser, physicalSettlement: browser.then(() => undefined),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {},
  });
  await expect(settleActiveCompactionSource(request(true), source, broker)).resolves.toEqual({
    answer: "The ordinary response reached its terminal boundary.",
    compactionInstructionDelivered: false,
  });
  expect(requested).toBe(1);
});

test("active compaction aborts its source when the shared handoff deadline expires", async () => {
  const controller = new AbortController();
  const deadlineError = new Error("shared compaction deadline expired");
  const browser = new Promise<string>(() => {});
  let cancellations = 0;
  const broker = {
    requestCompaction: () => 0,
    compactionDeliveryCount: () => 0,
    completeTool() { throw new Error("no tool result should be delivered"); },
    revoke() {},
  } as unknown as TurnBroker;
  const source = new ChatGptTurnSession({
    mode: "tools", token: Promise.resolve("turn_active_deadline"),
    externalProgress: { recordToolResult() {} } as never,
    browser, physicalSettlement: browser.then(() => undefined),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    cancel: () => { cancellations += 1; },
  });
  setTimeout(() => controller.abort(deadlineError), 10);

  await expect(settleActiveCompactionSource(
    request(true),
    source,
    broker,
    controller.signal,
  )).rejects.toThrow("shared compaction deadline expired");
  expect(cancellations).toBe(1);
});

test("active compaction interrupts a queued MCP call that Codex never started waiting for", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-compaction-queued-call-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [{
        name: "exec_command",
        description: "Run one command",
        parameters: { type: "object" },
      }],
    }, 10_000, "trace_queued_compaction");
    const claimed = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim",
      token,
    });
    const queuedInvocation = callTurnBroker<BrokerToolResult>(broker.socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "must-not-run" },
    });
    const browser = queuedInvocation.then(result => {
      expect(result.isError).toBeTrue();
      expect(JSON.stringify(result.content)).toContain(CODEX_ACTIVE_COMPACTION_REQUEST_MARKER);
      expect(JSON.stringify(result.content)).toContain("The tool was not executed");
      expect(JSON.stringify(result.content)).not.toContain("codex.control.compaction_handoff");
      return "Stopped for the retained compaction handoff";
    });
    const source = new ChatGptTurnSession({
      mode: "tools",
      token: Promise.resolve(token),
      externalProgress: {
        recordToolResult() {},
      } as never,
      browser,
      physicalSettlement: browser.then(() => undefined),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      retireCapability: () => broker.revoke(token),
      cancel() {},
    });

    await expect(settleActiveCompactionSource(request(true), source, broker)).resolves.toEqual({
      answer: "Stopped for the retained compaction handoff",
      compactionInstructionDelivered: true,
    });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a later native message waits for the current response and its physical settlement without preempting it", async () => {
  const sessions = new ChatGptTurnSessions();
  let finishClient!: (answer: string) => void;
  let settlePhysical!: () => void;
  const clientOutcome = new Promise<string>(resolve => { finishClient = resolve; });
  const physicalSettlement = new Promise<void>(resolve => { settlePhysical = resolve; });
  let cancellations = 0;
  sessions.getOrCreate("old", () => ({
    mode: "read-only",
    browser: clientOutcome,
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancellations += 1; },
  }), "old_trace", "same_owner");
  let starts = 0;
  const replacement = sessions.getOrCreateAfterOwnerRetirement("new", "same_owner", () => {
    starts += 1;
    return {
      mode: "read-only" as const,
      browser: Promise.resolve("new"),
      physicalSettlement: Promise.resolve(),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel() {},
    };
  });

  await Bun.sleep(0);
  expect(starts).toBe(0);
  expect(cancellations).toBe(0);
  finishClient("old complete");
  await Bun.sleep(0);
  expect(starts).toBe(0);
  settlePhysical();
  await replacement;
  expect(starts).toBe(1);
  expect(cancellations).toBe(0);
  sessions.clear();
});

test("a later native message still waits when logical completion happened before ownership lookup", async () => {
  const sessions = new ChatGptTurnSessions();
  let settlePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { settlePhysical = resolve; });
  const completed = sessions.getOrCreate("old-completed", () => ({
    mode: "read-only",
    browser: Promise.resolve("logical result"),
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() {},
  }), "old_trace", "same_owner_after_result");
  await completed.browserOutcome;

  let starts = 0;
  const replacement = sessions.getOrCreateAfterOwnerRetirement(
    "new-after-result",
    "same_owner_after_result",
    () => {
      starts += 1;
      return {
        mode: "read-only" as const,
        browser: Promise.resolve("new"),
        physicalSettlement: Promise.resolve(),
        trace: new ChatGptTraceFeed(),
        text: new ChatGptTextFeed(),
        cancel() {},
      };
    },
  );
  await Bun.sleep(0);
  expect(starts).toBe(0);
  settlePhysical();
  await replacement;
  expect(starts).toBe(1);
  sessions.clear();
});

test("retained conversation release waits for physical settlement", async () => {
  const sessions = new ChatGptTurnSessions();
  let settlePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { settlePhysical = resolve; });
  let releases = 0;
  sessions.getOrCreate("retained", () => ({
    mode: "read-only",
    browser: Promise.resolve("done"),
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey: "a".repeat(64),
    releaseRetainedConversation: async () => { releases += 1; },
    cancel() {},
  }));
  const retirement = sessions.retireConversationAndWait("a".repeat(64));
  await Bun.sleep(0);
  expect(releases).toBe(0);
  settlePhysical();
  expect(await retirement).toBe(1);
  expect(releases).toBe(1);
});

test("a repeated compaction waits for the previous conversation retirement", async () => {
  const sessions = new ChatGptTurnSessions();
  const conversationKey = "c".repeat(64);
  let settlePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { settlePhysical = resolve; });
  sessions.getOrCreate("retained-repeating", () => ({
    mode: "read-only",
    browser: Promise.resolve("done"),
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey,
    releaseRetainedConversation: async () => {},
    cancel() {},
  }));

  const retirement = sessions.retireConversationAndWait(conversationKey);
  let waited = false;
  const nextCompaction = sessions.waitForConversationRetirement(conversationKey).then(() => {
    waited = true;
  });
  await Bun.sleep(0);
  expect(waited).toBeFalse();
  settlePhysical();
  await retirement;
  await nextCompaction;
  expect(waited).toBeTrue();
});

test("retained compaction can close its browser epoch while preserving an ordinary final response", async () => {
  const sessions = new ChatGptTurnSessions();
  const conversationKey = "b".repeat(64);
  const text = new ChatGptTextFeed();
  text.push("ordinary final answer");
  let releases = 0;
  let replacementStarts = 0;
  const source = sessions.getOrCreate("ordinary-final", () => ({
    mode: "read-only",
    browser: Promise.resolve("ordinary final answer"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text,
    conversationKey,
    releaseRetainedConversation: async () => { releases += 1; },
    cancel() {},
  }));
  await source.browserOutcome;
  await source.physicalSettlement;

  expect(await sessions.retireConversationPreservingFinalResponse(
    conversationKey,
    source,
    "compacted-ordinary-final",
  )).toBe(1);
  expect(releases).toBe(1);
  expect(source.conversationKey()).toBeUndefined();
  expect(sessions.findConversationHead(conversationKey)).toBeUndefined();
  expect(sessions.find("ordinary-final")).toBeUndefined();
  expect(sessions.find("compacted-ordinary-final")).toBe(source);
  expect(sessions.getOrCreate("compacted-ordinary-final", () => {
    replacementStarts += 1;
    throw new Error("the committed final response must be replayed, not replaced");
  })).toBe(source);
  expect(replacementStarts).toBe(0);
  sessions.clear();
});
