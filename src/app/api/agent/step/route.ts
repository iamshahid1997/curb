/**
 * One step of the agent loop.
 *
 * Stateless by design. The client owns the loop and the trace because every
 * tool executes in the browser against the sandbox — running the loop
 * server-side would mean a network round trip per probe, and a run makes many.
 * This endpoint exists to hold the API key and the system prompt, nothing more.
 *
 * Given the conversation so far it returns the model's next move: some text,
 * and zero or more tool calls for the client to execute.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, tool, type ModelMessage } from "ai";
import { NextResponse } from "next/server";

import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { TOOL_DESCRIPTIONS, TOOL_SCHEMAS, type ToolName } from "@/lib/agent/tools";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Tried in order until one answers.
 *
 * Free-tier model availability is genuinely unstable: gemini-3.7-flash returns
 * 503 "high demand" intermittently, and gemini-2.5-flash is now 404 for new
 * accounts. A demo that dies because one model is busy is not a demo, so we
 * fall back rather than pick a favourite. CURB_MODEL pins a single model when
 * you want determinism instead.
 */
const MODEL_CHAIN = process.env.CURB_MODEL
  ? [process.env.CURB_MODEL]
  : ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.7-flash"];

/** Worth retrying on the next model rather than failing the run. */
function isTransient(message: string): boolean {
  return /503|high demand|overload|unavailable|not found|404|no longer available/i.test(
    message,
  );
}

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort, per-instance. Serverless means each cold instance gets its own
 * map, so this is a speed bump against casual abuse of our shared key, not a
 * real quota. Users who bring their own key bypass it entirely, which is the
 * intended path for anything sustained.
 */
const WINDOW_MS = 60_000;
const MAX_STEPS_PER_WINDOW = 40;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);

  if (hits.size > 500) {
    for (const [key, times] of hits) {
      if (!times.some((t) => now - t < WINDOW_MS)) hits.delete(key);
    }
  }

  return recent.length > MAX_STEPS_PER_WINDOW;
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Declared without `execute` on purpose: the SDK then returns the tool call
 * instead of running it, and the client fulfils it against the sandbox.
 *
 * Written out rather than generated from TOOL_SCHEMAS with Object.fromEntries —
 * that widens every schema to a union and TypeScript resolves the input type to
 * `never`, so the tools typecheck but accept nothing.
 */
const tools = {
  drive: tool({
    description: TOOL_DESCRIPTIONS.drive,
    inputSchema: TOOL_SCHEMAS.drive,
  }),
  run_axe: tool({
    description: TOOL_DESCRIPTIONS.run_axe,
    inputSchema: TOOL_SCHEMAS.run_axe,
  }),
  read_transcript: tool({
    description: TOOL_DESCRIPTIONS.read_transcript,
    inputSchema: TOOL_SCHEMAS.read_transcript,
  }),
  trace_focus_order: tool({
    description: TOOL_DESCRIPTIONS.trace_focus_order,
    inputSchema: TOOL_SCHEMAS.trace_focus_order,
  }),
  snapshot_a11y_tree: tool({
    description: TOOL_DESCRIPTIONS.snapshot_a11y_tree,
    inputSchema: TOOL_SCHEMAS.snapshot_a11y_tree,
  }),
  apply_patch: tool({
    description: TOOL_DESCRIPTIONS.apply_patch,
    inputSchema: TOOL_SCHEMAS.apply_patch,
  }),
  report_findings: tool({
    description: TOOL_DESCRIPTIONS.report_findings,
    inputSchema: TOOL_SCHEMAS.report_findings,
  }),
};

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

interface StepRequest {
  messages: ModelMessage[];
  /** Bring-your-own key. Never logged, never persisted. */
  apiKey?: string;
}

const MAX_MESSAGES = 60;
const MAX_BODY_CHARS = 400_000;

export async function POST(request: Request) {
  let body: StepRequest;

  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) {
      return NextResponse.json({ error: "Conversation too large." }, { status: 413 });
    }
    body = JSON.parse(raw) as StepRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ error: "messages is required." }, { status: 400 });
  }

  if (body.messages.length > MAX_MESSAGES) {
    return NextResponse.json(
      { error: "Run exceeded its step budget." },
      { status: 400 },
    );
  }

  const userKey = body.apiKey?.trim();
  const apiKey = userKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "No API key configured. Set GOOGLE_GENERATIVE_AI_API_KEY, or supply your " +
          "own key in the UI.",
        code: "no-key",
      },
      { status: 503 },
    );
  }

  // Only meter our shared key.
  if (!userKey) {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    if (rateLimited(ip)) {
      return NextResponse.json(
        { error: "Rate limit reached. Add your own API key to keep going.", code: "rate-limited" },
        { status: 429 },
      );
    }
  }

  const google = createGoogleGenerativeAI({ apiKey });
  const started = Date.now();
  const attempted: string[] = [];
  let lastError = "";

  for (const modelId of MODEL_CHAIN) {
    attempted.push(modelId);

    try {
      const result = await generateText({
        model: google(modelId),
        system: SYSTEM_PROMPT,
        messages: body.messages,
        tools,
        // One model turn per request — the client drives the loop.
        maxRetries: 1,
      });

      return NextResponse.json({
        text: result.text,
        toolCalls: result.toolCalls.map((call) => ({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
        })),
        finishReason: result.finishReason,
        usage: {
          inputTokens: result.usage?.inputTokens ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
        },
        model: modelId,
        attempted,
        ms: Date.now() - started,
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);

      // Quota is not transient — falling through to another model on the same
      // key would just burn another request against the same exhausted budget.
      if (/quota|RESOURCE_EXHAUSTED|429/i.test(lastError)) {
        return NextResponse.json(
          { error: lastError, code: "quota-exhausted", attempted },
          { status: 429 },
        );
      }

      if (!isTransient(lastError)) break;
    }
  }

  return NextResponse.json(
    { error: lastError || "All models failed.", code: "model-error", attempted },
    { status: 502 },
  );
}
