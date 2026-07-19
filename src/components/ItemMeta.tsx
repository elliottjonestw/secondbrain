// Reusable Tags + Links panel. Drop it into any item's detail/edit view; it
// works for events, reminders, todos, and notes uniformly via the shared
// item_tags and links tables — the whole point of the cross-linking design.

import { useEffect, useState } from "react";
import { X, Link2, Plus } from "lucide-react";
import type { ItemType, TagRow, LinkRow } from "../types";
import {
  tagsForItem, tagItem, untagItem,
  linksForItem, createLink, deleteLink, getItemLabel,
} from "../db";
import { Button } from "./ui";

const TYPE_LABEL: Record<ItemType, string> = {
  event: "Event", reminder: "Reminder", todo: "Todo", note: "Note",
};

export function TagEditor({ type, id }: { type: ItemType; id: string }) {
  const [tags, setTags] = useState<TagRow[]>([]);
  const [input, setInput] = useState("");

  const reload = () => tagsForItem(type, id).then(setTags);
  useEffect(() => { void reload(); }, [type, id]);

  async function add() {
    const name = input.trim();
    if (!name) return;
    await tagItem(name, type, id);
    setInput("");
    void reload();
  }

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-neutral-500">Tags</label>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((t) => (
          <span key={t.id} className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-700">
            #{t.name}
            <button
              onClick={async () => { await untagItem(t.id, type, id); void reload(); }}
              className="text-neutral-400 hover:text-red-500"
              aria-label={`Remove tag ${t.name}`}
            ><X size={12} /></button>
          </span>
        ))}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void add())}
          placeholder="add tag…"
          className="w-24 rounded border border-neutral-200 px-2 py-0.5 text-xs outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-700"
        />
      </div>
    </div>
  );
}

/** Options for the "link to…" picker: every item except the current one. */
export interface LinkTarget { type: ItemType; id: string; label: string; }

export function LinksPanel({
  type, id, targets,
}: {
  type: ItemType;
  id: string;
  targets: LinkTarget[];
}) {
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState(false);

  const reload = async () => {
    const ls = await linksForItem(type, id);
    setLinks(ls);
    const entries = await Promise.all(
      ls.map(async (l) => {
        const other = l.source_type === type && l.source_id === id
          ? { t: l.target_type, i: l.target_id }
          : { t: l.source_type, i: l.source_id };
        return [l.id, `${TYPE_LABEL[other.t]}: ${await getItemLabel(other.t, other.i)}`] as const;
      }),
    );
    setLabels(Object.fromEntries(entries));
  };
  useEffect(() => { void reload(); }, [type, id]);

  const available = targets.filter((t) => !(t.type === type && t.id === id));

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-neutral-500">Linked items</label>
      <div className="space-y-1">
        {links.map((l) => (
          <div key={l.id} className="flex items-center justify-between rounded bg-neutral-50 px-2 py-1 text-xs dark:bg-neutral-700/50">
            <span className="flex items-center gap-1.5"><Link2 size={13} className="text-neutral-400" /> {labels[l.id] ?? "…"}</span>
            <button
              onClick={async () => { await deleteLink(l.id); void reload(); }}
              className="text-neutral-400 hover:text-red-500"
              aria-label="Remove link"
            ><X size={12} /></button>
          </div>
        ))}
        {links.length === 0 && <p className="text-xs text-neutral-400">No links yet.</p>}
      </div>

      {picking ? (
        <select
          autoFocus
          className="mt-2 w-full rounded border border-neutral-200 px-2 py-1 text-xs dark:border-neutral-600 dark:bg-neutral-700"
          onChange={async (e) => {
            const [t, i] = e.target.value.split("::");
            if (t && i) { await createLink(type, id, t as ItemType, i); }
            setPicking(false);
            void reload();
          }}
          defaultValue=""
        >
          <option value="" disabled>Choose an item to link…</option>
          {available.map((t) => (
            <option key={`${t.type}::${t.id}`} value={`${t.type}::${t.id}`}>
              {TYPE_LABEL[t.type]}: {t.label}
            </option>
          ))}
        </select>
      ) : (
        <Button variant="ghost" className="mt-1 px-1" onClick={() => setPicking(true)}><span className="flex items-center gap-1"><Plus size={14} /> Link item</span></Button>
      )}
    </div>
  );
}
