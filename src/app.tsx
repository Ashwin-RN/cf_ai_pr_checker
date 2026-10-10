import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isChatWorkspace, newChatWorkspace } from "./workspace";
import type { UIMessage } from "ai";
import type { ChatAgent } from "./server";
import type {
  CheckResult,
  Progress,
  ProgressFile,
  RuleSet
} from "./checker/types";
import type { CheckRow } from "./store";
import type { Stats } from "./stats";
import { mechanicalKind } from "./checker/mechanical";
import { renderReport } from "./checker/report";
import { statsMarkdown } from "./stats";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  PoweredByCloudflare,
  Table,
  Tabs,
  Text
} from "@cloudflare/kumo";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
  ChatCircleDotsIcon,
  CheckCircleIcon,
  CircleIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  SidebarSimpleIcon,
  SpinnerGapIcon,
  StopIcon,
  SunIcon,
  TrashIcon,
  XCircleIcon
} from "@phosphor-icons/react";

// One Durable Object per workspace. The id lives in the URL so the page can be
// shared or reopened; a fresh visit gets a fresh id.
function workspaceId(): string {
  const match = /^\/w\/([^/]+)$/.exec(location.pathname);
  if (match && isChatWorkspace(match[1])) return match[1];
  const id = newChatWorkspace();
  history.replaceState(null, "", `/w/${id}`);
  return id;
}

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );

  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);

  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

function FileState({ state }: { state: ProgressFile["state"] }) {
  if (state === "checked") {
    return (
      <CheckCircleIcon size={14} weight="fill" className="text-kumo-success" />
    );
  }
  if (state === "failed") {
    return <XCircleIcon size={14} weight="fill" className="text-kumo-danger" />;
  }
  if (state === "checking") {
    return (
      <SpinnerGapIcon size={14} className="animate-spin text-kumo-default" />
    );
  }
  return <CircleIcon size={14} className="text-kumo-subtle" />;
}

// One card per check, updated in place while files move through the pipeline.
function ProgressCard({ progress }: { progress: Progress }) {
  const done = progress.files.filter(
    (f) => f.state === "checked" || f.state === "failed"
  ).length;
  return (
    <div className="max-w-[85%] w-full rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default p-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">{progress.message}</span>
        {progress.files.length > 0 && (
          <span className="text-kumo-subtle tabular-nums">
            {done}/{progress.files.length}
          </span>
        )}
      </div>
      {progress.files.length > 0 && (
        <ul className="mt-2 space-y-1 font-mono text-xs">
          {progress.files.map((f) => (
            <li key={f.path} className="flex items-center gap-2">
              <FileState state={f.state} />
              <span className={f.state === "queued" ? "text-kumo-subtle" : ""}>
                {f.path}
                {f.role === "evidence" ? " (requested evidence)" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type PanelTab = "rules" | "history" | "stats";

const TABS: Array<{ value: PanelTab; label: string }> = [
  { value: "rules", label: "Rules" },
  { value: "history", label: "History" },
  { value: "stats", label: "Stats" }
];

function statusBadge(status: string) {
  const variant =
    status === "pass"
      ? "success"
      : status === "fail"
        ? "error"
        : status === "unsure"
          ? "warning"
          : "neutral";
  return <Badge variant={variant}>{status}</Badge>;
}

function prLabel(prUrl: string): string {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(prUrl);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : prUrl;
}

function when(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

type Panel = {
  rules: RuleSet | null;
  checks: CheckRow[];
  stats: Stats | null;
};

// The workspace beside the chat: its saved rules as interpreted, every
// check run here with its report on request, and how each rule has fared.
// Everything is read from the workspace's Durable Object; nothing here
// spends a model call.
function WorkspacePanel({
  agent,
  version,
  onCheckAgain,
  onClose
}: {
  agent: ReturnType<typeof useAgent<ChatAgent>>;
  version: number;
  onCheckAgain: (prUrl: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<PanelTab>("history");
  const [data, setData] = useState<Panel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<CheckResult | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  // The client stub types the agent's callable methods loosely, so the
  // results are named here; the server's methods are the source of truth.
  useEffect(() => {
    let live = true;
    Promise.all([
      agent.call("getRules") as Promise<RuleSet | null>,
      agent.call("listChecks", [50]) as Promise<CheckRow[]>,
      agent.call("getStats") as Promise<Stats>
    ])
      .then(([rules, checks, stats]) => {
        if (live) {
          setData({ rules, checks, stats });
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [agent, version]);

  const open = useCallback(
    (id: string) => {
      setOpening(id);
      (agent.call("getCheck", [id]) as Promise<CheckResult | null>)
        .then((result) => {
          if (result) setReport(result);
          else setError(`Check ${id.slice(0, 8)} has no report yet.`);
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setOpening(null));
    },
    [agent]
  );

  return (
    <aside className="flex flex-col h-full w-full lg:w-[32rem] shrink-0 border-l border-kumo-line bg-kumo-base text-kumo-default">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-kumo-line">
        <Tabs
          variant="segmented"
          size="sm"
          tabs={TABS}
          value={tab}
          onValueChange={(v) => {
            setTab(v as PanelTab);
            setReport(null);
          }}
        />
        <Button
          variant="secondary"
          shape="square"
          aria-label="Close the workspace panel"
          icon={<SidebarSimpleIcon size={16} />}
          onClick={onClose}
        />
      </div>
      <div className="flex-1 overflow-y-auto p-4 text-sm">
        {error && (
          <Text size="sm" variant="secondary">
            {error}
          </Text>
        )}
        {!data && !error && (
          <Text size="sm" variant="secondary">
            Loading…
          </Text>
        )}
        {data && tab === "rules" && <RulesTab rules={data.rules} />}
        {data && tab === "history" && !report && (
          <HistoryTab checks={data.checks} opening={opening} onOpen={open} />
        )}
        {data && tab === "history" && report && (
          <ReportView
            report={report}
            onBack={() => setReport(null)}
            onCheckAgain={() => onCheckAgain(report.pr.url)}
          />
        )}
        {data && tab === "stats" && <StatsTab stats={data.stats} />}
      </div>
    </aside>
  );
}

function RulesTab({ rules }: { rules: RuleSet | null }) {
  if (!rules) {
    return (
      <Text size="sm" variant="secondary">
        No rules are saved in this workspace. A repository with a pr-rules.md is
        checked against that file; send a message starting with{" "}
        <code>rules:</code> to save rules for the rest.
      </Text>
    );
  }
  return (
    <div className="space-y-3">
      <Text size="sm" variant="secondary">
        {rules.rules.length} rules from {rules.source}, set{" "}
        <code>{rules.hash}</code>. A repository with a pr-rules.md is checked
        against that file instead.
      </Text>
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>#</Table.Head>
            <Table.Head>Rule</Table.Head>
            <Table.Head>Reads as</Table.Head>
            <Table.Head>Checked by</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rules.rules.map((r) => (
            <Table.Row key={r.id}>
              <Table.Cell>{r.id}</Table.Cell>
              <Table.Cell>
                {r.text}
                <div className="text-xs text-kumo-subtle mt-1">
                  {r.appliesTo?.join(", ") ?? "everywhere"}
                </div>
              </Table.Cell>
              <Table.Cell className="whitespace-nowrap">
                {r.polarity === "must_not" ? "must not" : "must"}
                {r.scope === "cross_file" ? ", may span files" : ""}
              </Table.Cell>
              <Table.Cell>
                {mechanicalKind(r.text) ? "pattern" : "model"}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}

function HistoryTab({
  checks,
  opening,
  onOpen
}: {
  checks: CheckRow[];
  opening: string | null;
  onOpen: (id: string) => void;
}) {
  if (!checks.length) {
    return (
      <Text size="sm" variant="secondary">
        No checks yet. Paste a pull request link in the chat.
      </Text>
    );
  }
  return (
    <Table>
      <Table.Header>
        <Table.Row>
          <Table.Head>When</Table.Head>
          <Table.Head>Pull request</Table.Head>
          <Table.Head>Status</Table.Head>
          <Table.Head>Report</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {checks.map((c) => (
          <Table.Row key={c.id}>
            <Table.Cell className="whitespace-nowrap tabular-nums text-xs">
              {when(c.startedAt)}
            </Table.Cell>
            <Table.Cell>
              <a
                href={c.prUrl}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {prLabel(c.prUrl)}
              </a>
            </Table.Cell>
            <Table.Cell>{statusBadge(c.status)}</Table.Cell>
            <Table.Cell>
              {c.finishedAt !== null && c.status !== "error" ? (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={opening === c.id}
                  onClick={() => onOpen(c.id)}
                >
                  Open
                </Button>
              ) : (
                <span className="text-xs text-kumo-subtle">
                  {c.status === "error" ? "failed" : "running"}
                </span>
              )}
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}

// A stored report, rendered by the same code as the chat's.
function ReportView({
  report,
  onBack,
  onCheckAgain
}: {
  report: CheckResult;
  onBack: () => void;
  onCheckAgain: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<ArrowLeftIcon size={14} />}
          onClick={onBack}
        >
          All checks
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<ArrowsClockwiseIcon size={14} />}
          onClick={onCheckAgain}
        >
          Check again
        </Button>
      </div>
      <Streamdown className="sd-theme" plugins={{ code }} controls={false}>
        {renderReport(report, { json: false })}
      </Streamdown>
    </div>
  );
}

function StatsTab({ stats }: { stats: Stats | null }) {
  if (!stats) return null;
  return (
    <Streamdown className="sd-theme" plugins={{ code }} controls={false}>
      {statsMarkdown(stats)}
    </Streamdown>
  );
}

function Chat() {
  const [workspace] = useState(workspaceId);
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  // Bumped when a reply ends, so the panel reads the workspace again.
  const [version, setVersion] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const agent = useAgent<ChatAgent>({
    agent: "ChatAgent",
    name: workspace,
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), [])
  });

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent,
    experimental_throttle: 100
  });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (connected && !isStreaming) textareaRef.current?.focus();
  }, [connected, isStreaming]);

  useEffect(() => {
    if (!isStreaming) setVersion((v) => v + 1);
  }, [isStreaming]);

  const sendText = useCallback(
    (text: string) => {
      sendMessage({ role: "user", parts: [{ type: "text", text }] });
    },
    [sendMessage]
  );

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendText(text);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, isStreaming, sendText]);

  return (
    <div className="flex h-screen bg-kumo-elevated">
      <div
        className={`flex flex-col h-full flex-1 min-w-0 ${panelOpen ? "hidden lg:flex" : ""}`}
      >
        <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
          <div className="max-w-3xl mx-auto flex items-center justify-between">
            <h1 className="text-lg font-semibold text-kumo-default">
              PR checker
            </h1>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <CircleIcon
                  size={8}
                  weight="fill"
                  className={
                    connected ? "text-kumo-success" : "text-kumo-danger"
                  }
                />
                <Text size="xs" variant="secondary">
                  {connected ? "Connected" : "Disconnected"}
                </Text>
              </div>
              <ThemeToggle />
              <Button
                variant="secondary"
                icon={<SidebarSimpleIcon size={16} />}
                onClick={() => setPanelOpen((o) => !o)}
                aria-pressed={panelOpen}
              >
                Workspace
              </Button>
              <Button
                variant="secondary"
                icon={<TrashIcon size={16} />}
                onClick={clearHistory}
              >
                Clear
              </Button>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
            {messages.length === 0 && (
              <Empty
                icon={<ChatCircleDotsIcon size={32} />}
                title="Give it rules, then paste a pull request link"
                contents={
                  <Text size="sm" variant="secondary">
                    Describe your rules in plain English. Then paste a public
                    GitHub pull request link. The Workspace panel lists the
                    rules, every check run here, and how each rule has fared.
                  </Text>
                }
              />
            )}

            {messages.map((message: UIMessage, index: number) => {
              const isUser = message.role === "user";
              const isLastAssistant = !isUser && index === messages.length - 1;

              return (
                <div key={message.id} className="space-y-2">
                  {message.parts.map((part, i) => {
                    const key = `${message.id}-${i}`;
                    if (part.type === "data-check") {
                      return (
                        <div key={key} className="flex justify-start">
                          <ProgressCard progress={part.data as Progress} />
                        </div>
                      );
                    }
                    if (part.type !== "text" || !part.text) return null;

                    if (isUser) {
                      return (
                        <div key={key} className="flex justify-end">
                          <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed whitespace-pre-wrap">
                            {part.text}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={key} className="flex justify-start">
                        <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                          <Streamdown
                            className="sd-theme rounded-2xl rounded-bl-md p-3"
                            plugins={{ code }}
                            controls={false}
                            isAnimating={isLastAssistant && isStreaming}
                          >
                            {part.text}
                          </Streamdown>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}

            <div ref={endRef} />
          </div>
        </div>

        <div className="border-t border-kumo-line bg-kumo-base">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            className="max-w-3xl mx-auto px-5 py-4"
          >
            <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
              <InputArea
                ref={textareaRef}
                value={input}
                onValueChange={setInput}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = `${el.scrollHeight}px`;
                }}
                placeholder="Rules, a pull request link, answer Q1: …, waive rule 2: …, history, stats"
                disabled={!connected || isStreaming}
                rows={1}
                className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
              />
              {isStreaming ? (
                <Button
                  type="button"
                  variant="secondary"
                  shape="square"
                  aria-label="Stop"
                  icon={<StopIcon size={18} />}
                  onClick={stop}
                  className="mb-0.5"
                />
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  shape="square"
                  aria-label="Send"
                  disabled={!input.trim() || !connected}
                  icon={<PaperPlaneRightIcon size={18} />}
                  className="mb-0.5"
                />
              )}
            </div>
          </form>
          <div className="flex justify-center pb-3">
            <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
          </div>
        </div>
      </div>

      {panelOpen && (
        <WorkspacePanel
          agent={agent}
          version={version}
          onCheckAgain={(prUrl) => {
            setPanelOpen(false);
            sendText(prUrl);
          }}
          onClose={() => setPanelOpen(false)}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <Chat />
    </Suspense>
  );
}
