import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";
import type { ChatAgent } from "./server";
import {
  Button,
  Empty,
  InputArea,
  PoweredByCloudflare,
  Text
} from "@cloudflare/kumo";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  ChatCircleDotsIcon,
  CircleIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  StopIcon,
  SunIcon,
  TrashIcon
} from "@phosphor-icons/react";

// One Durable Object per workspace. The id lives in the URL so the page can be
// shared or reopened; a fresh visit gets a fresh id.
function workspaceId(): string {
  const match = /^\/w\/([a-z0-9]{20,})$/.exec(location.pathname);
  if (match) return match[1];
  const id = crypto.randomUUID().replaceAll("-", "");
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

function Chat() {
  const [workspace] = useState(workspaceId);
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
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

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, isStreaming, sendMessage]);

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
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
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              <Text size="xs" variant="secondary">
                {connected ? "Connected" : "Disconnected"}
              </Text>
            </div>
            <ThemeToggle />
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
                  GitHub pull request link.
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
                  if (part.type !== "text" || !part.text) return null;
                  const key = `${message.id}-${i}`;

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
              placeholder="Rules, or a pull request link"
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
