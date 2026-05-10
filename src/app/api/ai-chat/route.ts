import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";
import WebSocket from "ws";

const SESSION_ID =
  "1vPQa-lPs3NA4I2kaeo6Q0LhDBmPGjOa.veUPz8AFwc6JaWQ+SdezaCimfH4PG3+jEVNSnLO8xhI";
const GRAPHQL_HTTP = "https://biz-graphql.tenbin.ai/graphql";
const GRAPHQL_WS = "wss://biz-graphql.tenbin.ai/graphql";

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

  // 最新200件を時系列で取得
  const recent = messages.slice(-200);

  // キーワードマッチで関連メッセージも追加
  const q = question.toLowerCase();
  const keywords = q
    .replace(/[?？！!。、,.\s]/g, " ")
    .split(" ")
    .filter((w) => w.length >= 2);

  const related = messages.filter((m) => {
    const content = m.content.toLowerCase();
    return keywords.some((kw) => content.includes(kw));
  });

  // 重複排除・時系列ソート
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

async function graphqlMutation<T = unknown>(
  operationName: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const res = await fetch(GRAPHQL_HTTP, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/graphql-response+json",
    },
    body: JSON.stringify({ operationName, query, variables }),
  });

  // Set-Cookie から sessionId を拾う（初回）
  const setCookie = res.headers.get("set-cookie");
  const cookie =
    setCookie?.match(/sessionId=([^;]+)/)?.[1] ?? SESSION_ID;

  const data = (await res.json()) as any;
  if (data.errors) {
    throw new Error(data.errors[0]?.message || "GraphQL error");
  }
  return { ...data.data, _cookie: cookie } as T;
}

function wsQuery(
  historyId: string,
  model: string = "OpenAIgpt54"
): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GRAPHQL_WS, ["graphql-transport-ws"]);
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

    // 1. prepareConversation
    const prepareRes: any = await graphqlMutation(
      "prepareConversationBackground",
      `mutation prepareConversationBackground($chatType: ChatType!) {
        prepareConversationBackground(chatType: $chatType) { historyId }
      }`,
      { chatType: "CHAT" }
    );
    const historyId = prepareRes.prepareConversationBackground.historyId;

    // 2. issue token
    const tokenRes: any = await graphqlMutation(
      "IssueExecutionTokensMultiple",
      `query IssueExecutionTokensMultiple($recaptchaToken: String!, $models: [ChatModel!]!) {
        executionTokens: issueExecutionTokensMultiple(recaptchaToken: $recaptchaToken, models: $models)
      }`,
      { recaptchaToken: "test", models: ["OpenAIgpt54"] }
    );
    const executionToken = JSON.parse(tokenRes.executionTokens)[0];

    // 3. start conversation
    await graphqlMutation(
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

    // 4. WebSocket streaming
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
