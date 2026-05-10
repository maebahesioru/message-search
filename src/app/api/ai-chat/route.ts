import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";
import WebSocket from "ws";

const GRAPHQL_HTTP = "https://biz-graphql.tenbin.ai/graphql";
const GRAPHQL_WS = "wss://biz-graphql.tenbin.ai/graphql";

function getSessionId(): string {
  const id = process.env.TENBIN_SESSION_ID;
  if (!id) throw new Error("TENBIN_SESSION_ID is not set in environment");
  return id;
}

let cachedMessages: Array<{
  ts: string;
  author: string;
  author_id: string;
  content: string;
  has_attach: boolean;
  attach_urls: string[];
}> | null = null;

function getMessages() {
  if (cachedMessages) return cachedMessages;
  const fp = path.join(process.cwd(), "public", "messages.json");
  cachedMessages = JSON.parse(fs.readFileSync(fp, "utf-8"));
  return cachedMessages!;
}

function formatTs(ts: string) {
  return new Date(ts).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildContext(question: string) {
  const messages = getMessages();
  const authors = [...new Set(messages.map((m) => m.author))];

  const recent = messages.slice(-200);

  const q = question.toLowerCase();
  const keywords = q
    .replace(/[?？！!。、,.\s]/g, " ")
    .split(" ")
    .filter((w) => w.length >= 2);

  const related = messages.filter((m) => {
    const content = m.content.toLowerCase();
    return keywords.some((kw) => content.includes(kw));
  });

  const seen = new Set<string>();
  const contextMessages = [...recent, ...related]
    .filter((m) => {
      if (seen.has(m.ts)) return false;
      seen.add(m.ts);
      return true;
    })
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-300);

  const lines = contextMessages.map((m) => {
    const date = formatTs(m.ts);
    const content = m.content.replace(/\n/g, " ");
    return `[${date}] ${m.author}: ${content}`;
  });

  return {
    authors,
    total: messages.length,
    contextLines: lines,
    dateRange: `${formatTs(messages[0].ts)} 〜 ${formatTs(messages[messages.length - 1].ts)}`,
  };
}

async function graphqlRequest<T = unknown>(
  operationName: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const sessionId = getSessionId();
  const res = await fetch(GRAPHQL_HTTP, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/graphql-response+json",
      Cookie: `sessionId=${sessionId}`,
    },
    body: JSON.stringify({ operationName, query, variables }),
  });

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `GraphQL response parse error (${res.status}): ${text.substring(0, 200)}`
    );
  }
  if (data.errors) {
    throw new Error(data.errors[0]?.message || "GraphQL error");
  }
  return data.data as T;
}

function wsQuery(
  historyId: string,
  model: string = "OpenAIgpt54"
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sessionId = getSessionId();
    const ws = new WebSocket(GRAPHQL_WS, ["graphql-transport-ws"], {
      headers: {
        Cookie: `sessionId=${sessionId}`,
        Origin: "https://biz.tenbin.ai",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    const id = crypto.randomUUID();
    let text = "";
    let timeout: NodeJS.Timeout;

    const clear = () => {
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {}
    };

    timeout = setTimeout(() => {
      clear();
      reject(new Error("WebSocket timeout"));
    }, 120_000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "connection_init" }));
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "connection_ack") {
        ws.send(
          JSON.stringify({
            id,
            type: "subscribe",
            payload: {
              operationName: "ContinueConversation",
              query: `subscription ContinueConversation($historyId: String!, $model: String!, $isReconnecting: Boolean) {
                continueConversation(historyId: $historyId, model: $model, isReconnecting: $isReconnecting) {
                  seq deltaToken isFinished newStateToken error action activity id isReconnectionReplay __typename
                }
              }`,
              variables: { historyId, model, isReconnecting: false },
            },
          })
        );
      }
      if (msg.type === "next" && msg.payload?.data?.continueConversation) {
        const d = msg.payload.data.continueConversation;
        if (d.deltaToken) text += d.deltaToken;
        if (d.isFinished) {
          clear();
          resolve(text);
        }
      }
      if (msg.type === "complete") {
        clear();
        resolve(text);
      }
      if (msg.type === "error") {
        clear();
        reject(new Error(msg.payload?.message || "WS error"));
      }
    });

    ws.on("error", (err) => {
      clear();
      reject(err);
    });

    ws.on("close", () => {
      clear();
      resolve(text);
    });
  });
}

export async function POST(req: NextRequest) {
  try {
    const { question, systemHint } = await req.json();
    if (!question || typeof question !== "string") {
      return Response.json({ error: "question required" }, { status: 400 });
    }

    const ctx = buildContext(question);

    const systemPrompt =
      systemHint ||
      `あなたはDiscord DMのログ分析アシスタントです。
以下のDMログ（${ctx.total}件、${ctx.dateRange}）を元に、ユーザーの質問に答えてください。
話者: ${ctx.authors.join(", ")}

【DMログ（抜粋）】
${ctx.contextLines.slice(-150).join("\n")}

上記ログを参考に、日本語で簡潔・正確に答えてください。ログに無い情報は「ログには記載がない」と述べてください。`;

    const prepareRes: any = await graphqlRequest(
      "prepareConversationBackground",
      `mutation prepareConversationBackground($chatType: ChatType!) {
        prepareConversationBackground(chatType: $chatType) { historyId }
      }`,
      { chatType: "CHAT" }
    );
    const historyId = prepareRes.prepareConversationBackground.historyId;

    const tokenRes: any = await graphqlRequest(
      "IssueExecutionTokensMultiple",
      `query IssueExecutionTokensMultiple($recaptchaToken: String!, $models: [ChatModel!]!) {
        executionTokens: issueExecutionTokensMultiple(recaptchaToken: $recaptchaToken, models: $models)
      }`,
      { recaptchaToken: "test", models: ["OpenAIgpt54"] }
    );
    const rawTokens = tokenRes.executionTokens;
    const executionToken = Array.isArray(rawTokens) ? rawTokens[0] : JSON.parse(rawTokens)[0];

    await graphqlRequest(
      "startConversationBackground",
      `mutation startConversationBackground(
        $historyId: String!, $executionToken: String!, $systemPrompt: String, $prompt: String
      ) {
        startConversationBackground(
          historyId: $historyId, executionToken: $executionToken,
          systemPrompt: $systemPrompt, prompt: $prompt
        ) { historyId }
      }`,
      { historyId, executionToken, systemPrompt, prompt: question }
    );

    const answer = await wsQuery(historyId, "OpenAIgpt54");

    return Response.json({ answer, historyId });
  } catch (err: any) {
    console.error("AI chat error:", err);
    return Response.json(
      { error: err.message || "Internal error" },
      { status: 500 }
    );
  }
}
