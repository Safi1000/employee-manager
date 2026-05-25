// Floating AI chat widget — bottom-right, always available across the app.
//
// What this is:
//   - Calls the `ai-chat` edge function which runs OpenAI gpt-5-mini with a
//     fixed tool catalogue (cashflow, payroll, top employees, etc).
//   - Sends the user's JWT in the Authorization header. The edge function uses
//     that JWT for every data query so RLS scopes the answer to the user's
//     own company. There is no way for the AI to see another company's data
//     from here — it physically cannot run an unscoped query.
//   - Conversation history is in-memory only (resets on page refresh). The
//     full history is replayed to the function each turn so the model can
//     handle follow-ups like "what about last month?".
//
// What this is NOT:
//   - The AI cannot write anything to the database. Every tool is read-only.
//   - The AI cannot answer general questions; the edge function's system
//     prompt forces an "I can only answer questions about your CRM data."
//     refusal for anything off-topic.

import { useEffect, useRef, useState } from "react";
import { Bot, Send, Loader2, X, Trash2 } from "lucide-react";
import { supabase } from "../lib/supabase";

type ChatMessage = { role: "user" | "assistant"; content: string };

// Few example prompts surfaced when the chat is empty, to seed the user with
// the kind of questions the assistant can actually answer.
const EXAMPLE_PROMPTS = [
  "Give me a company overview",
  "Cashflow breakdown this month",
  "Top 5 highest-paid employees",
  "Invoice aging report",
  "Who's absent today?",
  "Undisbursed payslips this month",
  "Top expense categories year-to-date",
  "Contracts ending in the next 60 days",
];

export default function AiChatWidget() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to the newest message whenever the conversation grows or the
  // pending spinner appears.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, sending]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
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
        body: { messages: next },
      });
      if (fnErr) {
        // The edge function stashes the actual error body on .context. Pull it
        // out so the user sees something more useful than "non-2xx status".
        let detail = fnErr.message;
        try {
          const ctx = (fnErr as { context?: Response }).context;
          if (ctx) detail = (await ctx.clone().json())?.error ?? detail;
        } catch { /* ignore */ }
        throw new Error(detail);
      }
      const reply = (data as { reply?: string })?.reply ?? "";
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
    // Enter to send, Shift+Enter for newline — matches Slack / ChatGPT.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const clearChat = () => {
    setMessages([]);
    setError(null);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Ask the CRM assistant"
        className="fixed bottom-6 right-6 z-40 flex items-center justify-center w-14 h-14 rounded-full bg-brand-600 text-white shadow-lg hover:bg-brand-700 transition-colors"
      >
        <Bot className="w-6 h-6" strokeWidth={1.5} />
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-40 w-[min(420px,calc(100vw-2rem))] h-[min(620px,calc(100vh-3rem))] bg-white border border-slate-200 rounded-xl shadow-xl flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-slate-50">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center">
            <Bot className="w-4 h-4 text-white" strokeWidth={1.5} />
          </div>
          <div>
            <p className="text-sm font-medium text-slate-900">CRM Assistant</p>
            <p className="text-[11px] text-slate-500">Read-only · scoped to your data</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={clearChat}
              title="Clear conversation"
              className="p-1.5 rounded hover:bg-slate-200 text-slate-600"
            >
              <Trash2 className="w-4 h-4" strokeWidth={1.5} />
            </button>
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
        {messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Ask about your CRM data. The assistant can read cashflow, payroll,
              attendance, invoices, expenses, cheques, banks, employees and clients —
              but only what you have permission to see.
            </p>
            <div className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Try asking</p>
              {EXAMPLE_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => sendMessage(p)}
                  className="block w-full text-left text-sm text-slate-700 px-3 py-2 rounded-md border border-slate-200 hover:bg-slate-50"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <MessageBubble key={i} message={m} />
        ))}

        {sending && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            Thinking…
          </div>
        )}

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
            placeholder="Ask about your CRM…"
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
  );
}

// Tiny renderer for one message. Assistant messages can include simple
// markdown (tables, **bold**, lists) — we render them as plain text with
// preserved newlines for now. If we add real markdown later, swap to
// react-markdown here.
function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={
          isUser
            ? "max-w-[85%] px-3 py-2 rounded-lg bg-brand-600 text-white text-sm whitespace-pre-wrap break-words"
            : "max-w-[85%] px-3 py-2 rounded-lg bg-slate-100 text-slate-900 text-sm whitespace-pre-wrap break-words"
        }
      >
        {message.content}
      </div>
    </div>
  );
}
