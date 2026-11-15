import { useState, useRef, useEffect, type FormEvent } from 'react';
import Icon from './Icon';

interface ChatEntry {
  id: number;
  name: string;
  text: string;
  mine: boolean;
}

interface ChatProps {
  myName: string;
  onSend: (text: string) => void;
  messages: ChatEntry[];
  canSend: boolean;
}

export default function Chat({ myName: _myName, onSend, messages, canSend }: ChatProps) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const prevLastIdRef = useRef(0);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    const latestId = messages.at(-1)?.id ?? 0;
    if (!open && latestId > prevLastIdRef.current) {
      const newMessages = messages.filter((message) => message.id > prevLastIdRef.current).length;
      setUnread((u) => u + newMessages);
    }
    prevLastIdRef.current = latestId;
  }, [messages, open]);

  function handleOpen() {
    setOpen(true);
    setUnread(0);
  }

  function handleSend(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
  }

  return (
    <div className="relative">
      {/* Toggle button */}
      <button
        onClick={() => (open ? setOpen(false) : handleOpen())}
        className="relative flex h-10 w-10 items-center justify-center rounded-full bg-gray-700 text-lg hover:bg-gray-600"
        title="Chat"
        aria-label={open ? 'Close chat' : 'Open chat'}
      >
        <Icon name="chat" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-xs font-bold">
            {unread}
          </span>
        )}
      </button>

      {/* Chat panel */}
      {open && (
        <div className="absolute bottom-14 right-0 flex w-72 flex-col rounded-xl bg-gray-900 shadow-2xl border border-gray-700">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-gray-700 px-3 py-2">
            <span className="text-sm font-semibold">Chat</span>
            <button onClick={() => setOpen(false)} className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-white" aria-label="Close chat"><Icon name="close" size={16} /></button>
          </div>

          {/* Messages */}
          <div ref={listRef} className="flex flex-col gap-2 overflow-y-auto p-3 h-56">
            {!canSend && <p role="status" className="text-center text-xs text-yellow-300">Connecting chat…</p>}
            {messages.length === 0 ? (
              <p className="text-center text-xs text-gray-500 mt-auto">No messages yet</p>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex flex-col ${m.mine ? 'items-end' : 'items-start'}`}
                >
                  <span className="text-xs text-gray-500 mb-0.5">{m.name}</span>
                  <span
                    className={`max-w-[90%] rounded-lg px-3 py-1.5 text-sm break-words ${
                      m.mine ? 'bg-blue-700 text-white' : 'bg-gray-700 text-gray-100'
                    }`}
                  >
                    {m.text}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Input */}
          <form onSubmit={handleSend} className="flex gap-2 border-t border-gray-700 p-2">
            <input
              type="text"
              value={text}
              disabled={!canSend}
              onChange={(e) => setText(e.target.value)}
              maxLength={500}
              placeholder="Type a message…"
              className="flex-1 rounded bg-gray-800 px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={!canSend || !text.trim()}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm font-semibold hover:bg-blue-500 disabled:opacity-50"
            >
              Send
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

export type { ChatEntry };
