// Floating AI chat widget — bottom-right, always available across the app.
// Calls the `ai-chat` edge function which runs OpenAI gpt-5-mini against a
// fixed catalogue of read-only tools. The user's JWT is forwarded so every
// query inherits RLS scoping; cross-company data is unreachable from here.

import { useEffect, useRef, useState } from "react";
import { Bot, Send, Loader2, X, Trash2, Copy, Check } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { supabase } from "../lib/supabase";

type ChatMessage = { role: "user" | "assistant"; content: string };

export default function AiChatWidget() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Server-issued thread id. null = haven't started a conversation yet; the
  // edge function returns one on the first reply and we echo it back on every
  // subsequent call so the persisted transcript stays in one thread.
  const [threadId, setThreadId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to the newest message / spinner whenever they appear.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, sending]);

  // Focus the input as soon as the panel finishes opening.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 180);
      return () => clearTimeout(t);
    }
  }, [open]);

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setError(null);
    const next = [...messages, { role: "user" as const, content: trimmed }];
    setMessages(next);
    setInput("");
    setSending(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error("Not signed in — refresh the page and try again.");
      const { data, error: fnErr } = await supabase.functions.invoke("ai-chat", {
        body: { messages: next, thread_id: threadId },
      });
      if (fnErr) {
        // Pull the real error body out of supabase-js's wrapper.
        let detail = fnErr.message;
        try {
          const ctx = (fnErr as { context?: Response }).context;
          if (ctx) detail = (await ctx.clone().json())?.error ?? detail;
        } catch { /* ignore */ }
        throw new Error(detail);
      }
      const reply = (data as { reply?: string; thread_id?: string })?.reply ?? "";
      const newThreadId = (data as { thread_id?: string })?.thread_id ?? null;
      if (newThreadId && newThreadId !== threadId) setThreadId(newThreadId);
      setMessages([...next, { role: "assistant", content: reply }]);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const clearChat = () => {
    // Drops the in-memory transcript and starts a fresh thread server-side.
    // The previous thread stays in the DB — Clear is a "new conversation"
    // not a "delete history" action.
    setMessages([]);
    setThreadId(null);
    setError(null);
  };

  const copyConversation = async () => {
    if (messages.length === 0) return;
    const md = messages
      .map((m) => {
        const who = m.role === "user" ? "**You:**" : "**Assistant:**";
        return `${who}\n\n${m.content}`;
      })
      .join("\n\n---\n\n");
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers / insecure origins can fall through; the user can
      // always select-and-copy manually. We just won't show the check tick.
    }
  };

  return (
    <>
      {/* Keyframes for the typing indicator dots. Inlined here so the widget
          is self-contained — no global stylesheet edit needed. */}
      <style>{`
        @keyframes ai-chat-dot {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40%           { transform: scale(1);   opacity: 1;   }
        }
        .ai-chat-dot {
          animation: ai-chat-dot 1.2s infinite ease-in-out;
        }
      `}</style>

      {/* Floating launcher button. Fades out as the panel opens so we don't
          stack two clickable circles in the same spot. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Open assistant"
        aria-label="Open assistant"
        className={`fixed bottom-6 right-6 z-40 flex items-center justify-center w-14 h-14 rounded-full bg-brand-600 text-white shadow-lg hover:bg-brand-700 transition-all duration-200 ease-out ${
          open
            ? "opacity-0 scale-90 pointer-events-none"
            : "opacity-100 scale-100"
        }`}
      >
        <Bot className="w-6 h-6" strokeWidth={1.5} />
      </button>

      {/* Chat panel. Always mounted so the close animation can play; visibility
          and pointer events are toggled instead of mount/unmount. */}
      <div
        className={`fixed bottom-6 right-6 z-40 w-[min(420px,calc(100vw-2rem))] h-[min(620px,calc(100vh-3rem))] bg-white border border-slate-200 rounded-xl shadow-xl flex flex-col overflow-hidden origin-bottom-right transition-all duration-200 ease-out ${
          open
            ? "opacity-100 scale-100 translate-y-0 pointer-events-auto"
            : "opacity-0 scale-95 translate-y-2 pointer-events-none"
        }`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center">
              <Bot className="w-4 h-4 text-white" strokeWidth={1.5} />
            </div>
            <p className="text-sm font-medium text-slate-900">Assistant</p>
          </div>
          <div className="flex items-center gap-1">
            {messages.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={copyConversation}
                  title="Copy conversation as markdown"
                  className="p-1.5 rounded hover:bg-slate-200 text-slate-600"
                >
                  {copied ? (
                    <Check className="w-4 h-4 text-success-600" strokeWidth={1.5} />
                  ) : (
                    <Copy className="w-4 h-4" strokeWidth={1.5} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={clearChat}
                  title="New conversation"
                  className="p-1.5 rounded hover:bg-slate-200 text-slate-600"
                >
                  <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              title="Close"
              className="p-1.5 rounded hover:bg-slate-200 text-slate-600"
            >
              <X className="w-4 h-4" strokeWidth={1.5} />
            </button>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {messages.map((m, i) => (
            <MessageBubble key={i} message={m} />
          ))}

          {sending && <TypingIndicator />}

          {error && (
            <div className="text-sm text-danger-700 bg-danger-50 border border-danger-200 rounded-md px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="border-t border-slate-200 p-3 bg-white">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={sending}
              rows={1}
              placeholder="Type a message…"
              className="flex-1 resize-none px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent disabled:bg-slate-50 min-h-[40px] max-h-32"
            />
            <button
              type="submit"
              disabled={sending || !input.trim()}
              className="flex items-center justify-center w-10 h-10 rounded-md bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Send"
            >
              {sending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" strokeWidth={1.5} />
              )}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  if (isUser) {
    // User input never contains markdown — render as plain text so any "**" or
    // pipe characters they typed survive verbatim.
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-3 py-2 rounded-lg bg-brand-600 text-white text-sm whitespace-pre-wrap break-words">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] px-3 py-2 rounded-lg bg-slate-100 text-slate-900 text-sm break-words ai-md">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          // Override the default tag rendering with classnames tuned for a
          // small chat bubble. Tables get borders and tight cell padding;
          // paragraphs and lists get the kind of vertical rhythm you'd want
          // inside a 400px-wide bubble rather than a full document.
          components={{
            p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
            strong: ({ children }) => <strong className="font-semibold text-slate-900">{children}</strong>,
            em: ({ children }) => <em className="italic">{children}</em>,
            ul: ({ children }) => <ul className="list-disc pl-5 mb-2 last:mb-0 space-y-0.5">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 last:mb-0 space-y-0.5">{children}</ol>,
            li: ({ children }) => <li className="leading-relaxed">{children}</li>,
            h1: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1 first:mt-0">{children}</h3>,
            h2: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1 first:mt-0">{children}</h3>,
            h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1 first:mt-0">{children}</h3>,
            code: ({ children }) => (
              <code className="px-1 py-0.5 rounded bg-slate-200 text-slate-800 text-[12px] font-mono">
                {children}
              </code>
            ),
            pre: ({ children }) => (
              <pre className="my-2 p-2 rounded bg-slate-200 text-slate-800 text-[12px] font-mono overflow-x-auto">
                {children}
              </pre>
            ),
            blockquote: ({ children }) => (
              <blockquote className="border-l-2 border-slate-300 pl-2 my-2 text-slate-600">
                {children}
              </blockquote>
            ),
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noreferrer" className="text-brand-700 underline hover:text-brand-800">
                {children}
              </a>
            ),
            // Tables — most CRM answers come back as a table, so this is the
            // most important block to get right. Compact padding, subtle
            // borders, sticky header look.
            table: ({ children }) => (
              <div className="my-2 overflow-x-auto -mx-1">
                <table className="w-full border-collapse text-[12px]">{children}</table>
              </div>
            ),
            thead: ({ children }) => <thead className="bg-slate-200/60">{children}</thead>,
            th: ({ children }) => (
              <th className="px-2 py-1.5 text-left font-medium text-slate-700 border-b border-slate-300">
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td className="px-2 py-1.5 border-b border-slate-200 align-top">{children}</td>
            ),
            hr: () => <hr className="my-2 border-slate-200" />,
          }}
        >
          {message.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}

// Three softly pulsing dots inside an assistant-style bubble. Each dot is
// offset by 200ms so the whole sequence reads as a wave rather than a flash.
function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="px-3 py-2.5 rounded-lg bg-slate-100 flex items-center gap-1.5">
        <span
          className="ai-chat-dot inline-block w-1.5 h-1.5 rounded-full bg-slate-500"
          style={{ animationDelay: "0ms" }}
        />
        <span
          className="ai-chat-dot inline-block w-1.5 h-1.5 rounded-full bg-slate-500"
          style={{ animationDelay: "200ms" }}
        />
        <span
          className="ai-chat-dot inline-block w-1.5 h-1.5 rounded-full bg-slate-500"
          style={{ animationDelay: "400ms" }}
        />
      </div>
    </div>
  );
}
