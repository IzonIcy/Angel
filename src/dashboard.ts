import type { AngelConfig } from "./config";

type DashboardDb = {
  query: (sql: string, ...params: unknown[]) => unknown;
};

type DashboardDeps = {
  config: AngelConfig;
  db: DashboardDb;
  startedAt: number;
};

const HTML_PAGE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>angel status</title>
  <style>
    body { background: #0d1117; color: #e6edf3; font-family: ui-monospace, monospace; max-width: 720px; margin: 40px auto; padding: 0 16px; }
    h1 { font-size: 1.2rem; }
    table { border-collapse: collapse; width: 100%; margin-top: 12px; }
    td, th { padding: 6px 10px; border-bottom: 1px solid #21262d; text-align: left; font-size: 0.9rem; }
    a { color: #58a6ff; }
    .ok { color: #3fb950; }
  </style>
</head>
<body>
  <h1>angel is running</h1>
  <table id="stats"></table>
  <p><a href="/metrics">/metrics</a> &middot; refreshes every 5s</p>
  <script>
    async function refresh() {
      const res = await fetch('/api/stats');
      const stats = await res.json();
      const rows = Object.entries(stats).map(
        ([k, v]) => '<tr><td>' + k + '</td><td class="ok">' + v + '</td></tr>'
      );
      document.getElementById('stats').innerHTML = rows.join('');
    }
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;

/**
 * Read-only HTTP surface: a tiny status page and Prometheus-style metrics.
 * Enabled only when config.dashboard.enabled is true — default off.
 */
export function startDashboard(deps: DashboardDeps): {
  stop: () => Promise<void>;
  port: number;
} {
  const port = deps.config.dashboard?.port ?? 8642;
  const startedAt = deps.startedAt;

  const scalar = (sql: string, fallback = 0): number => {
    try {
      const row = deps.db.query(sql) as Record<string, unknown> | undefined;
      const value = row ? Object.values(row)[0] : fallback;
      return typeof value === "number" ? value : Number(value ?? fallback) || 0;
    } catch {
      return fallback;
    }
  };

  const collectStats = () => {
    const messagesLast24h = scalar(
      "SELECT COUNT(*) AS n FROM messages WHERE timestamp >= datetime('now', '-1 day')",
    );
    const userMessages = scalar(
      "SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND timestamp >= datetime('now', '-1 day')",
    );
    const toolCalls24h = scalar(
      "SELECT COUNT(*) AS n FROM tool_execution_logs WHERE created_at >= datetime('now', '-1 day')",
    );
    const toolErrors24h = scalar(
      "SELECT COUNT(*) AS n FROM tool_execution_logs WHERE success = 0 AND created_at >= datetime('now', '-1 day')",
    );
    const activeChats = scalar("SELECT COUNT(DISTINCT id) AS n FROM chats");

    return {
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      messages_last_24h: messagesLast24h,
      user_messages_last_24h: userMessages,
      tool_calls_last_24h: toolCalls24h,
      tool_errors_last_24h: toolErrors24h,
      known_chats: activeChats,
    };
  };

  const server = Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/metrics") {
        const s = collectStats();
        const lines: string[] = [
          "# TYPE angel_uptime_seconds gauge",
          `angel_uptime_seconds ${s.uptime_seconds}`,
          "# TYPE angel_messages_24h counter",
          `angel_messages_24h ${s.messages_last_24h}`,
          "# TYPE angel_user_messages_24h counter",
          `angel_user_messages_24h ${s.user_messages_last_24h}`,
          "# TYPE angel_tool_calls_24h counter",
          `angel_tool_calls_24h ${s.tool_calls_last_24h}`,
          "# TYPE angel_tool_errors_24h counter",
          `angel_tool_errors_24h ${s.tool_errors_last_24h}`,
          "# TYPE angel_known_chats gauge",
          `angel_known_chats ${s.known_chats}`,
        ];
        return new Response(lines.join("\n") + "\n", {
          headers: { "Content-Type": "text/plain; version=0.0.4" },
        });
      }

      if (url.pathname === "/api/stats") {
        return Response.json(collectStats());
      }

      if (url.pathname === "/") {
        return new Response(HTML_PAGE, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  console.log(`[angel] dashboard listening on http://127.0.0.1:${server.port}`);
  return { stop: () => server.stop(true), port };
}
