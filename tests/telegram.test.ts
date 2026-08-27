import { afterEach, describe, expect, it } from "bun:test";
import { TelegramChannel } from "../src/channels/telegram";

// Minimal fetch mock covering the Bot API surface the channel uses.
const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; body: any }> = [];

function fakeOk(result: unknown) {
  return new Response(JSON.stringify({ ok: true, result }), {
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
});

describe("TelegramChannel", () => {
  it("maps telegram updates into IncomingMessage fields", async () => {
    let pollCount = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: init?.body ? JSON.parse(init.body as string) : {},
      });
      if ((url as string).endsWith("/getMe")) {
        return fakeOk({ id: 42 });
      }
      if ((url as string).endsWith("/getUpdates")) {
        pollCount += 1;
        if (pollCount === 1) {
          return fakeOk([
            {
              update_id: 100,
              message: {
                message_id: 7,
                chat: { id: -100123, type: "group" },
                from: {
                  id: 555,
                  username: "ryan",
                  first_name: "Ryan",
                  last_name: "B",
                },
                text: "hello angel",
              },
            },
          ]);
        }
        // stop the loop after the first batch
        throw new Error("stop polling");
      }
      return fakeOk({});
    }) as typeof fetch;

    const channel = new TelegramChannel("test-token", ["555"]);
    const received: Array<{
      externalChatId: string;
      chatType: string;
      senderName: string;
      text: string;
    }> = [];
    await channel.start(async (msg) => {
      received.push({
        externalChatId: msg.externalChatId,
        chatType: msg.chatType,
        senderName: msg.senderName,
        text: msg.text,
      });
    });

    // wait for one poll cycle to process
    await new Promise((r) => setTimeout(r, 50));
    await channel.stop();

    expect(received).toEqual([
      {
        externalChatId: "-100123",
        chatType: "telegram_group",
        senderName: "ryan",
        text: "hello angel",
      },
    ]);
    expect(pollCount).toBeGreaterThanOrEqual(1);
  });

  it("sendText posts to sendMessage with chat_id and text", async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: init?.body ? JSON.parse(init.body as string) : {},
      });
      return fakeOk({});
    }) as typeof fetch;

    const channel = new TelegramChannel("test-token");
    await channel.sendText("12345", "hi there");

    const send = calls.find((c) => c.url.endsWith("/sendMessage"));
    expect(send).toBeDefined();
    expect(send!.body).toEqual({ chat_id: "12345", text: "hi there" });
  });

  it("blocks messages from senders not on the allowlist", async () => {
    let pollCount = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if ((url as string).endsWith("/getMe")) return fakeOk({ id: 42 });
      if ((url as string).endsWith("/getUpdates")) {
        pollCount += 1;
        if (pollCount === 1) {
          return fakeOk([
            {
              update_id: 200,
              message: {
                message_id: 8,
                chat: { id: -100123, type: "group" },
                from: { id: 999, username: "stranger" },
                text: "let me in",
              },
            },
          ]);
        }
        throw new Error("stop polling");
      }
      return fakeOk({});
    }) as typeof fetch;

    const channel = new TelegramChannel("test-token", ["555"]);
    const received: unknown[] = [];
    await channel.start(async (msg) => {
      received.push(msg);
    });
    await new Promise((r) => setTimeout(r, 50));
    await channel.stop();

    expect(received).toEqual([]);
  });
});
